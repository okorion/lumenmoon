begin;

create or replace function public.bootstrap_player(
  p_world_id uuid default '00000000-0000-4000-8000-000000000001'::uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, auth, extensions
as $$
declare
  v_actor uuid := private.require_actor();
  v_profile public.profiles%rowtype;
  v_world public.worlds%rowtype;
  v_state public.player_world_state%rowtype;
  v_slot integer;
  v_now timestamptz := clock_timestamp();
  v_tag text;
begin
  perform pg_advisory_xact_lock(hashtextextended('bootstrap-player:' || v_actor::text, 0));

  select w.* into v_world
    from public.worlds as w
   where w.id = p_world_id and w.enabled
   for share;
  if not found then
    raise exception 'world is unavailable' using errcode = '22023';
  end if;

  select p.* into v_profile
    from public.profiles as p
   where p.user_id = v_actor;

  if not found then
    loop
      v_tag := private.random_public_tag();
      begin
        insert into public.profiles (user_id, public_tag, nickname, emblem, created_at)
        values (
          v_actor,
          v_tag,
          private.random_nickname(),
          private.random_emblem(),
          v_now
        )
        returning * into v_profile;
        exit;
      exception when unique_violation then
        -- Public tags are intentionally short; retry only the generated collision.
        if exists (select 1 from public.profiles where user_id = v_actor) then
          select p.* into strict v_profile
            from public.profiles as p where p.user_id = v_actor;
          exit;
        end if;
      end;
    end loop;
  end if;

  -- The world-scoped advisory lock makes smallest-free-slot allocation atomic;
  -- both (world,user) and (world,slot) unique constraints remain the final guard.
  perform pg_advisory_xact_lock(hashtextextended('starter-slots:' || p_world_id::text, 0));
  select s.* into v_state
    from public.player_world_state as s
   where s.world_id = p_world_id and s.player_id = v_actor;

  if not found then
    select candidate.slot
      into v_slot
      from generate_series(0, v_world.starter_slot_capacity - 1) as candidate(slot)
     where not exists (
       select 1
         from public.player_world_state as occupied
        where occupied.world_id = p_world_id
          and occupied.starter_slot = candidate.slot
     )
     order by candidate.slot
     limit 1;

    if v_slot is null then
      raise exception 'world starter slots are full' using errcode = '54000';
    end if;

    insert into public.player_world_state (
      world_id,
      player_id,
      starter_slot,
      inventory,
      initial_grant_claimed,
      last_settled_at,
      created_at,
      updated_at
    )
    values (p_world_id, v_actor, v_slot, 24, true, v_now, v_now, v_now)
    returning * into v_state;
  end if;

  return jsonb_build_object(
    'profile', jsonb_build_object(
      'public_tag', v_profile.public_tag,
      'nickname', v_profile.nickname,
      'emblem', v_profile.emblem
    ),
    'world', jsonb_build_object(
      'id', v_world.id,
      'slug', v_world.slug,
      'title', v_world.title
    ),
    'state', private.state_json(v_state),
    'progress', private.state_json(v_state),
    'server_now', v_now
  );
end;
$$;

create or replace function public.get_nearby_blocks(
  p_world_id uuid,
  p_chunk_x integer,
  p_chunk_z integer,
  p_radius integer default 1
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  v_actor uuid := private.require_actor();
  v_blocks jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_radius < 0 or p_radius > 2 then
    raise exception 'chunk radius must be between 0 and 2' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.player_world_state as s
     where s.world_id = p_world_id and s.player_id = v_actor
  ) then
    raise exception 'player is not bootstrapped in this world' using errcode = '42501';
  end if;

  select coalesce(
    jsonb_agg(private.block_public_json(b) order by b.created_at, b.id),
    '[]'::jsonb
  )
    into v_blocks
    from public.blocks as b
   where b.world_id = p_world_id
     and b.zone <> 'mission'
     and b.chunk_x between p_chunk_x - p_radius and p_chunk_x + p_radius
     and b.chunk_z between p_chunk_z - p_radius and p_chunk_z + p_radius;

  return jsonb_build_object('blocks', v_blocks, 'server_now', v_now);
end;
$$;

create or replace function public.get_public_profiles(p_public_tags text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  v_profiles jsonb;
begin
  perform private.require_actor();
  if coalesce(cardinality(p_public_tags), 0) > 64 then
    raise exception 'at most 64 public profiles may be requested' using errcode = '22023';
  end if;
  if exists (
    select 1
      from unnest(coalesce(p_public_tags, '{}'::text[])) as requested(tag)
     where requested.tag is null
        or requested.tag !~ '^#[A-HJ-NP-Z2-9]{4}$'
  ) then
    raise exception 'invalid public profile tag' using errcode = '22023';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'public_tag', p.public_tag,
        'nickname', p.nickname,
        'emblem', p.emblem
      ) order by p.public_tag
    ),
    '[]'::jsonb
  )
    into v_profiles
    from public.profiles as p
   where p.public_tag = any(coalesce(p_public_tags, '{}'::text[]));

  return jsonb_build_object('profiles', v_profiles);
end;
$$;

create or replace function public.commit_world_actions(
  p_world_id uuid,
  p_idempotency_key uuid,
  p_actions jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, auth, extensions
as $$
declare
  v_actor uuid := private.require_actor();
  v_now timestamptz := clock_timestamp();
  v_hash bytea;
  v_existing public.idempotent_operations%rowtype;
  v_state public.player_world_state%rowtype;
  v_profile public.profiles%rowtype;
  v_action jsonb;
  v_action_type text;
  v_count integer;
  v_block_id uuid;
  v_x integer;
  v_y integer;
  v_z integer;
  v_kind public.block_kind;
  v_rotation smallint;
  v_color smallint;
  v_support_id uuid;
  v_zone record;
  v_guide record;
  v_support public.blocks%rowtype;
  v_block public.blocks%rowtype;
  v_upserted jsonb := '[]'::jsonb;
  v_removed jsonb := '[]'::jsonb;
  v_reset_removed jsonb := '[]'::jsonb;
  v_response jsonb;
  v_base_count integer;
  v_producer_count integer;
  v_upgrade_count integer;
  v_was_operational boolean;
  v_is_operational boolean;
  v_auto_produced integer := 0;
begin
  if p_idempotency_key is null then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_actions) <> 'array' then
    raise exception 'actions must be a JSON array' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_actions);
  if v_count < 1 or v_count > 24 then
    raise exception 'action count must be between 1 and 24' using errcode = '22023';
  end if;
  if octet_length(p_actions::text) > 32768 then
    raise exception 'action payload exceeds 32768 bytes' using errcode = '22023';
  end if;

  v_hash := private.request_hash(
    jsonb_build_object('world_id', p_world_id, 'actions', p_actions)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'world-commit:' || p_world_id::text || ':' || v_actor::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select op.* into v_existing
    from public.idempotent_operations as op
   where op.world_id = p_world_id
     and op.player_id = v_actor
     and op.operation_key = p_idempotency_key;
  if found then
    if v_existing.operation_kind <> 'world-commit'
      or v_existing.request_hash <> v_hash then
      raise exception 'idempotency key was used with a different request'
        using errcode = '22023';
    end if;
    if v_existing.response is null then
      raise exception 'idempotent operation has no completed response'
        using errcode = '55000';
    end if;
    return v_existing.response || jsonb_build_object('replayed', true);
  end if;

  select s.* into v_state
    from public.player_world_state as s
   where s.world_id = p_world_id and s.player_id = v_actor
   for update;
  if not found then
    raise exception 'player is not bootstrapped in this world' using errcode = '42501';
  end if;
  select p.* into strict v_profile from public.profiles as p where p.user_id = v_actor;

  v_was_operational := private.production_operational(p_world_id, v_actor, v_state);
  v_auto_produced := private.settle_locked_production(p_world_id, v_actor, v_now);
  select s.* into strict v_state
    from public.player_world_state as s
   where s.world_id = p_world_id and s.player_id = v_actor;

  if exists (
    select 1 from jsonb_array_elements(p_actions) as a(value)
     where a.value ->> 'type' = 'reset_onboarding'
  ) then
    if v_count <> 1 or p_actions -> 0 ->> 'type' <> 'reset_onboarding' then
      raise exception 'reset_onboarding must be the only action' using errcode = '22023';
    end if;
    if v_state.trial_reward_claimed then
      raise exception 'completed onboarding cannot be reset' using errcode = '42501';
    end if;

    if exists (
      select 1
        from public.blocks as child
        join public.blocks as parent on parent.id = child.support_id
       where parent.world_id = p_world_id
         and parent.creator_id = v_actor
         and parent.source = 'onboarding'
         and not (
           child.world_id = p_world_id
           and child.creator_id = v_actor
           and child.source = 'onboarding'
         )
    ) then
      raise exception 'onboarding block is supporting a surviving block'
        using errcode = '23503';
    end if;

    with deleted as (
      delete from public.blocks as b
       where b.world_id = p_world_id
         and b.creator_id = v_actor
         and b.source = 'onboarding'
      returning b.id
    )
    select coalesce(jsonb_agg(id order by id), '[]'::jsonb)
      into v_reset_removed from deleted;

    update public.player_world_state
       set inventory = 24,
           initial_grant_claimed = true,
           base_completed = false,
           base_completed_at = null,
           producer_completed = false,
           producer_completed_at = null,
           trial_reward_claimed = false,
           production_level = 1,
           producer_upgrade_completed_at = null,
           last_settled_at = v_now,
           manual_production_at = '{}',
           updated_at = v_now
     where world_id = p_world_id and player_id = v_actor
     returning * into v_state;
    v_removed := v_reset_removed;
  else
    for v_action in select value from jsonb_array_elements(p_actions) loop
      if jsonb_typeof(v_action) <> 'object' then
        raise exception 'each action must be an object' using errcode = '22023';
      end if;
      v_action_type := v_action ->> 'type';

      if v_action_type = 'place' then
        begin
          v_block_id := (v_action ->> 'block_id')::uuid;
          v_x := (v_action ->> 'x')::integer;
          v_y := (v_action ->> 'y')::integer;
          v_z := (v_action ->> 'z')::integer;
          v_kind := (v_action ->> 'kind')::public.block_kind;
          v_rotation := (v_action ->> 'rotation')::smallint;
          v_color := (v_action ->> 'color_index')::smallint;
          v_support_id := case
            when v_action ? 'support_id'
              and jsonb_typeof(v_action -> 'support_id') <> 'null'
              then (v_action ->> 'support_id')::uuid
            else null
          end;
        exception when others then
          raise exception 'invalid place action payload' using errcode = '22023';
        end;

        if v_block_id is null
          or v_x not between -512 and 512
          or v_z not between -512 and 512
          or v_y not between 0 and 32760
          or v_rotation not between 0 and 3
          or v_color not between 0 and 11 then
          raise exception 'place action is outside world or palette bounds'
            using errcode = '22023';
        end if;
        if private.is_deterministic_system_cell(p_world_id, v_x, v_y, v_z) then
          raise exception 'deterministic system cell cannot be modified'
            using errcode = '42501';
        end if;
        if v_state.inventory <= 0 then
          raise exception 'insufficient inventory' using errcode = '22023';
        end if;

        select * into v_zone
          from private.position_zone(p_world_id, v_x, v_z);
        if v_zone.zone in ('mission', 'system') then
          raise exception 'protected zone cannot be modified' using errcode = '42501';
        end if;
        if v_zone.zone in ('personal', 'producer') and (
          v_zone.owner_id is distinct from v_actor
          or v_zone.slot_index <> v_state.starter_slot
        ) then
          raise exception 'private bay belongs to another player or is unassigned'
            using errcode = '42501';
        end if;

        if not v_state.trial_reward_claimed then
          select * into v_guide
            from private.guide_at(v_state.starter_slot, v_x, v_y, v_z);
          if not found
            or v_guide.guide_group not in ('base', 'producer')
            or v_guide.expected_kind <> v_kind
            or v_guide.expected_rotation <> v_rotation then
            raise exception 'onboarding allows only matching base and producer guides'
              using errcode = '42501';
          end if;
        end if;

        if v_support_id is not null then
          select b.* into v_support
            from public.blocks as b
           where b.id = v_support_id
           for key share;
          if not found then
            -- Starter platform blocks are deterministic client geometry rather
            -- than mutable DB rows. A y=1 private/producer guide may rest on
            -- that protected surface; persist NULL instead of an unverifiable ID.
            if v_y = 1 and v_zone.zone in ('personal', 'producer') then
              v_support_id := null;
            else
              raise exception 'supportId does not exist in this world'
                using errcode = '23503';
            end if;
          elsif v_support.world_id <> p_world_id
            or abs(v_support.x - v_x) + abs(v_support.y - v_y) + abs(v_support.z - v_z) <> 1 then
            raise exception 'supportId must reference an adjacent block in this world'
              using errcode = '23503';
          elsif v_support.zone in ('personal', 'producer')
            and v_support.creator_id <> v_actor then
            raise exception 'another player private block cannot be used as support'
              using errcode = '42501';
          end if;
        end if;

        begin
          insert into public.blocks (
            id, world_id, x, y, z, kind, rotation, color_index,
            creator_id, creator_public_tag, nickname_snapshot, creator_emblem,
            zone, zone_slot, support_id, source, created_at
          )
          values (
            v_block_id, p_world_id, v_x, v_y, v_z, v_kind, v_rotation, v_color,
            v_actor, v_profile.public_tag, v_profile.nickname, v_profile.emblem,
            v_zone.zone::public.block_zone,
            case when v_zone.zone in ('personal', 'producer') then v_zone.slot_index else null end,
            v_support_id,
            case when v_state.trial_reward_claimed
              then 'inventory'::public.block_source
              else 'onboarding'::public.block_source
            end,
            v_now
          )
          returning * into v_block;
        exception when unique_violation then
          raise exception 'block id or coordinate is already occupied' using errcode = '23505';
        end;

        update public.player_world_state
           set inventory = inventory - 1, updated_at = v_now
         where world_id = p_world_id and player_id = v_actor
         returning * into v_state;
        v_upserted := v_upserted || jsonb_build_array(private.block_public_json(v_block));

      elsif v_action_type = 'remove' then
        begin
          v_block_id := (v_action ->> 'block_id')::uuid;
        exception when others then
          raise exception 'invalid remove action payload' using errcode = '22023';
        end;
        select b.* into v_block
          from public.blocks as b
         where b.id = v_block_id and b.world_id = p_world_id
         for update;
        if not found then
          raise exception 'block does not exist' using errcode = 'P0002';
        end if;
        if v_block.zone in ('mission', 'system') or v_block.source = 'system' then
          raise exception 'protected block cannot be removed' using errcode = '42501';
        end if;
        if v_block.creator_id <> v_actor then
          raise exception 'foreign public blocks require dismantle RPCs'
            using errcode = '42501';
        end if;
        if v_block.zone in ('personal', 'producer')
          and v_block.zone_slot <> v_state.starter_slot then
          raise exception 'private bay belongs to another player' using errcode = '42501';
        end if;
        if exists (
          select 1 from public.blocks as child where child.support_id = v_block.id
        ) then
          raise exception 'block is supporting another block' using errcode = '23503';
        end if;

        delete from public.blocks where id = v_block.id;
        if v_block.source in ('onboarding', 'inventory') then
          update public.player_world_state
             set inventory = least(36, inventory + 1), updated_at = v_now
           where world_id = p_world_id and player_id = v_actor
           returning * into v_state;
        end if;
        v_removed := v_removed || to_jsonb(v_block.id);
      else
        raise exception 'unsupported action type' using errcode = '22023';
      end if;
    end loop;

    v_base_count := private.count_filled_guides(
      p_world_id, v_actor, v_state.starter_slot, 'base'
    );
    v_producer_count := private.count_filled_guides(
      p_world_id, v_actor, v_state.starter_slot, 'producer'
    );
    v_upgrade_count := private.count_filled_guides(
      p_world_id, v_actor, v_state.starter_slot, 'upgrade'
    );

    update public.player_world_state
       set base_completed = base_completed or v_base_count >= 16,
           base_completed_at = case
             when not base_completed and v_base_count >= 16 then v_now
             else base_completed_at
           end,
           producer_completed = producer_completed or v_producer_count >= 8,
           producer_completed_at = case
             when not producer_completed and v_producer_count >= 8 then v_now
             else producer_completed_at
           end,
           updated_at = v_now
     where world_id = p_world_id and player_id = v_actor
     returning * into v_state;

    if not v_state.trial_reward_claimed
      and v_base_count >= 16 and v_producer_count >= 8 then
      update public.player_world_state
         set trial_reward_claimed = true,
             inventory = least(36, inventory + 2),
             last_settled_at = v_now,
             updated_at = v_now
       where world_id = p_world_id and player_id = v_actor
       returning * into v_state;
    end if;

    v_is_operational := private.production_operational(p_world_id, v_actor, v_state);
    -- Facility break and repair both reset the DB clock before any upgrade
    -- reconciliation, preventing paused-time backlog or a 7->8->Lv2 bypass.
    if not v_is_operational or (not v_was_operational and v_is_operational) then
      update public.player_world_state
         set last_settled_at = greatest(last_settled_at, v_now),
             updated_at = greatest(updated_at, v_now)
       where world_id = p_world_id and player_id = v_actor
       returning * into v_state;
    end if;

    if v_is_operational
      and v_state.production_level = 1
      and v_upgrade_count >= 12 then
      update public.player_world_state
         set production_level = 2,
             producer_upgrade_completed_at = greatest(last_settled_at, v_now),
             last_settled_at = greatest(last_settled_at, v_now),
             updated_at = greatest(updated_at, v_now)
       where world_id = p_world_id and player_id = v_actor
       returning * into v_state;
    end if;
  end if;

  v_response := jsonb_build_object(
    'world_id', p_world_id,
    'idempotency_key', p_idempotency_key,
    'upserted_blocks', v_upserted,
    'removed_block_ids', v_removed,
    'progress', private.state_json(v_state),
    'automatic_produced', v_auto_produced,
    'server_now', v_now,
    'replayed', false
  );

  insert into public.idempotent_operations (
    world_id, player_id, operation_key, operation_kind, request_hash,
    status, response, created_at, completed_at
  ) values (
    p_world_id, v_actor, p_idempotency_key, 'world-commit', v_hash,
    'completed', v_response, v_now, v_now
  );
  return v_response;
end;
$$;

create or replace function public.settle_production(p_world_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  v_actor uuid := private.require_actor();
  v_now timestamptz := clock_timestamp();
  v_state public.player_world_state%rowtype;
  v_produced integer;
begin
  select s.* into v_state
    from public.player_world_state as s
   where s.world_id = p_world_id and s.player_id = v_actor
   for update;
  if not found then
    raise exception 'player is not bootstrapped in this world' using errcode = '42501';
  end if;

  v_produced := private.settle_locked_production(p_world_id, v_actor, v_now);
  select s.* into strict v_state
    from public.player_world_state as s
   where s.world_id = p_world_id and s.player_id = v_actor;
  return jsonb_build_object(
    'world_id', p_world_id,
    'produced', v_produced,
    'progress', private.state_json(v_state),
    'server_now', v_now
  );
end;
$$;

create or replace function public.start_manual_production(
  p_world_id uuid,
  p_session_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  v_actor uuid := private.require_actor();
  v_now timestamptz := clock_timestamp();
  v_ready_at timestamptz := v_now + interval '15 seconds';
  v_expires_at timestamptz := v_now + interval '5 minutes 15 seconds';
  v_hash bytea := private.request_hash(
    jsonb_build_object('world_id', p_world_id, 'session_id', p_session_id)
  );
  v_existing public.idempotent_operations%rowtype;
  v_state public.player_world_state%rowtype;
  v_recent timestamptz[];
  v_response jsonb;
begin
  if p_session_id is null then
    raise exception 'manual production session id is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('manual-start:' || p_world_id::text || ':' || v_actor::text || ':' || p_session_id::text, 0)
  );
  select op.* into v_existing
    from public.idempotent_operations as op
   where op.world_id = p_world_id
     and op.player_id = v_actor
     and op.operation_key = p_session_id;
  if found then
    if v_existing.operation_kind <> 'manual-start' or v_existing.request_hash <> v_hash then
      raise exception 'session id was used with a different request' using errcode = '22023';
    end if;
    return v_existing.response || jsonb_build_object('replayed', true);
  end if;

  select s.* into v_state
    from public.player_world_state as s
   where s.world_id = p_world_id and s.player_id = v_actor
   for update;
  if not found then
    raise exception 'player is not bootstrapped in this world' using errcode = '42501';
  end if;
  if not private.production_operational(p_world_id, v_actor, v_state) then
    raise exception 'production facility is not operational' using errcode = '42501';
  end if;
  perform private.settle_locked_production(p_world_id, v_actor, v_now);
  select s.* into strict v_state
    from public.player_world_state as s
   where s.world_id = p_world_id and s.player_id = v_actor;

  select coalesce(array_agg(t.produced_at order by t.produced_at), '{}'::timestamptz[])
    into v_recent
    from unnest(v_state.manual_production_at) as t(produced_at)
   where t.produced_at > v_now - interval '24 hours' and t.produced_at <= v_now;
  if cardinality(v_recent) >= 3 then
    raise exception 'manual production daily limit reached' using errcode = '22023';
  end if;
  if v_state.inventory >= 36 then
    raise exception 'inventory is full' using errcode = '22023';
  end if;

  update public.player_world_state
     set manual_production_at = v_recent, updated_at = v_now
   where world_id = p_world_id and player_id = v_actor
   returning * into v_state;
  v_response := jsonb_build_object(
    'world_id', p_world_id,
    'session_id', p_session_id,
    'ready_at', v_ready_at,
    'expires_at', v_expires_at,
    'progress', private.state_json(v_state),
    'server_now', v_now,
    'replayed', false
  );
  insert into public.idempotent_operations (
    world_id, player_id, operation_key, operation_kind, request_hash,
    status, ready_at, expires_at, response, created_at
  ) values (
    p_world_id, v_actor, p_session_id, 'manual-start', v_hash,
    'pending', v_ready_at, v_expires_at, v_response, v_now
  );
  return v_response;
end;
$$;

create or replace function public.complete_manual_production(
  p_world_id uuid,
  p_session_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  v_actor uuid := private.require_actor();
  v_now timestamptz := clock_timestamp();
  v_hash bytea := private.request_hash(
    jsonb_build_object(
      'world_id', p_world_id,
      'session_id', p_session_id,
      'idempotency_key', p_idempotency_key
    )
  );
  v_existing public.idempotent_operations%rowtype;
  v_session public.idempotent_operations%rowtype;
  v_state public.player_world_state%rowtype;
  v_recent timestamptz[];
  v_response jsonb;
begin
  if p_session_id is null or p_idempotency_key is null or p_session_id = p_idempotency_key then
    raise exception 'distinct session and idempotency keys are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('manual-complete:' || p_world_id::text || ':' || v_actor::text || ':' || p_idempotency_key::text, 0)
  );
  select op.* into v_existing
    from public.idempotent_operations as op
   where op.world_id = p_world_id
     and op.player_id = v_actor
     and op.operation_key = p_idempotency_key;
  if found then
    if v_existing.operation_kind <> 'manual-complete' or v_existing.request_hash <> v_hash then
      raise exception 'idempotency key was used with a different request' using errcode = '22023';
    end if;
    return v_existing.response || jsonb_build_object('replayed', true);
  end if;

  select op.* into v_session
    from public.idempotent_operations as op
   where op.world_id = p_world_id
     and op.player_id = v_actor
     and op.operation_key = p_session_id
     and op.operation_kind = 'manual-start'
   for update;
  if not found or v_session.status <> 'pending' then
    raise exception 'manual production session is not pending' using errcode = '22023';
  end if;
  if v_now < v_session.ready_at then
    raise exception 'manual production is not ready' using errcode = '22023';
  end if;
  if v_now > v_session.expires_at then
    raise exception 'manual production session expired' using errcode = '22023';
  end if;

  select s.* into strict v_state
    from public.player_world_state as s
   where s.world_id = p_world_id and s.player_id = v_actor
   for update;
  if not private.production_operational(p_world_id, v_actor, v_state) then
    raise exception 'production facility is not operational' using errcode = '42501';
  end if;
  perform private.settle_locked_production(p_world_id, v_actor, v_now);
  select s.* into strict v_state
    from public.player_world_state as s
   where s.world_id = p_world_id and s.player_id = v_actor;

  select coalesce(array_agg(t.produced_at order by t.produced_at), '{}'::timestamptz[])
    into v_recent
    from unnest(v_state.manual_production_at) as t(produced_at)
   where t.produced_at > v_now - interval '24 hours' and t.produced_at <= v_now;
  if cardinality(v_recent) >= 3 then
    raise exception 'manual production daily limit reached' using errcode = '22023';
  end if;
  if v_state.inventory >= 36 then
    raise exception 'inventory is full' using errcode = '22023';
  end if;

  update public.player_world_state
     set inventory = inventory + 1,
         manual_production_at = array_append(v_recent, v_now),
         updated_at = v_now
   where world_id = p_world_id and player_id = v_actor
   returning * into v_state;
  update public.idempotent_operations
     set status = 'completed', completed_at = v_now
   where world_id = p_world_id and player_id = v_actor and operation_key = p_session_id;

  v_response := jsonb_build_object(
    'world_id', p_world_id,
    'session_id', p_session_id,
    'produced', 1,
    'progress', private.state_json(v_state),
    'server_now', v_now,
    'replayed', false
  );
  insert into public.idempotent_operations (
    world_id, player_id, operation_key, operation_kind, request_hash,
    status, response, created_at, completed_at
  ) values (
    p_world_id, v_actor, p_idempotency_key, 'manual-complete', v_hash,
    'completed', v_response, v_now, v_now
  );
  return v_response;
end;
$$;

create or replace function public.start_dismantle(
  p_world_id uuid,
  p_block_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, auth, extensions
as $$
declare
  v_actor uuid := private.require_actor();
  v_now timestamptz := clock_timestamp();
  v_ticket public.dismantle_tickets%rowtype;
  v_block public.blocks%rowtype;
begin
  if p_block_id is null or p_idempotency_key is null then
    raise exception 'block and idempotency keys are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('dismantle-start:' || p_world_id::text || ':' || v_actor::text, 0)
  );
  select t.* into v_ticket
    from public.dismantle_tickets as t
   where t.world_id = p_world_id
     and t.player_id = v_actor
     and t.start_idempotency_key = p_idempotency_key;
  if found then
    if v_ticket.block_id <> p_block_id then
      raise exception 'idempotency key was used for another block' using errcode = '22023';
    end if;
    if v_ticket.status <> 'pending' then
      raise exception 'dismantle hold was cancelled or already consumed' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'world_id', p_world_id,
      'ticket_id', v_ticket.id,
      'block_id', v_ticket.block_id,
      'ready_at', v_ticket.ready_at,
      'expires_at', v_ticket.expires_at,
      'server_now', v_now,
      'replayed', true
    );
  end if;

  if not exists (
    select 1 from public.player_world_state as s
     where s.world_id = p_world_id and s.player_id = v_actor
  ) then
    raise exception 'player is not bootstrapped in this world' using errcode = '42501';
  end if;

  select b.* into v_block
    from public.blocks as b
   where b.id = p_block_id and b.world_id = p_world_id
   for update;
  if not found then
    raise exception 'block does not exist' using errcode = 'P0002';
  end if;
  if v_block.zone <> 'public' or v_block.source = 'system' then
    raise exception 'only public expansion blocks may be dismantled' using errcode = '42501';
  end if;
  if v_block.creator_id = v_actor then
    raise exception 'own blocks use commit_world_actions remove' using errcode = '22023';
  end if;
  if exists (select 1 from public.blocks as child where child.support_id = v_block.id) then
    raise exception 'block is supporting another block' using errcode = '23503';
  end if;

  -- A fresh hold invalidates every prior unfinished hold for this player.
  update public.dismantle_tickets
     set status = 'cancelled'
   where world_id = p_world_id and player_id = v_actor and status = 'pending';

  insert into public.dismantle_tickets (
    world_id, player_id, block_id, start_idempotency_key,
    status, started_at, ready_at, expires_at, created_at
  ) values (
    p_world_id, v_actor, p_block_id, p_idempotency_key,
    'pending', v_now, v_now + interval '2.5 seconds',
    v_now + interval '12.5 seconds', v_now
  ) returning * into v_ticket;

  return jsonb_build_object(
    'world_id', p_world_id,
    'ticket_id', v_ticket.id,
    'block_id', v_ticket.block_id,
    'ready_at', v_ticket.ready_at,
    'expires_at', v_ticket.expires_at,
    'server_now', v_now,
    'replayed', false
  );
end;
$$;

create or replace function public.cancel_dismantle(
  p_world_id uuid,
  p_ticket_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  v_actor uuid := private.require_actor();
  v_now timestamptz := clock_timestamp();
  v_cancelled boolean;
begin
  update public.dismantle_tickets
     set status = 'cancelled'
   where id = p_ticket_id
     and world_id = p_world_id
     and player_id = v_actor
     and status = 'pending';
  v_cancelled := found;
  return jsonb_build_object(
    'world_id', p_world_id,
    'ticket_id', p_ticket_id,
    'cancelled', v_cancelled,
    'server_now', v_now
  );
end;
$$;

create or replace function public.finish_dismantle(
  p_world_id uuid,
  p_ticket_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  v_actor uuid := private.require_actor();
  v_now timestamptz := clock_timestamp();
  v_hash bytea := private.request_hash(
    jsonb_build_object(
      'world_id', p_world_id,
      'ticket_id', p_ticket_id,
      'idempotency_key', p_idempotency_key
    )
  );
  v_existing public.idempotent_operations%rowtype;
  v_ticket public.dismantle_tickets%rowtype;
  v_block public.blocks%rowtype;
  v_state public.player_world_state%rowtype;
  v_response jsonb;
begin
  if p_ticket_id is null or p_idempotency_key is null then
    raise exception 'ticket and idempotency keys are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('dismantle-finish:' || p_world_id::text || ':' || v_actor::text || ':' || p_idempotency_key::text, 0)
  );
  select op.* into v_existing
    from public.idempotent_operations as op
   where op.world_id = p_world_id
     and op.player_id = v_actor
     and op.operation_key = p_idempotency_key;
  if found then
    if v_existing.operation_kind <> 'dismantle-finish' or v_existing.request_hash <> v_hash then
      raise exception 'idempotency key was used with a different request' using errcode = '22023';
    end if;
    return v_existing.response || jsonb_build_object('replayed', true);
  end if;

  select t.* into v_ticket
    from public.dismantle_tickets as t
   where t.id = p_ticket_id
     and t.world_id = p_world_id
     and t.player_id = v_actor
   for update;
  if not found or v_ticket.status <> 'pending' then
    raise exception 'dismantle ticket is not pending' using errcode = '22023';
  end if;
  if v_now < v_ticket.ready_at then
    raise exception 'dismantle hold has not reached 2.5 seconds' using errcode = '22023';
  end if;
  if v_now > v_ticket.expires_at then
    raise exception 'dismantle ticket expired; start a new continuous hold'
      using errcode = '22023';
  end if;

  select b.* into v_block
    from public.blocks as b
   where b.id = v_ticket.block_id and b.world_id = p_world_id
   for update;
  if not found then
    raise exception 'block no longer exists' using errcode = 'P0002';
  end if;
  if v_block.zone <> 'public'
    or v_block.source = 'system'
    or v_block.creator_id = v_actor then
    raise exception 'block is no longer eligible for foreign dismantle'
      using errcode = '42501';
  end if;
  if exists (select 1 from public.blocks as child where child.support_id = v_block.id) then
    raise exception 'block is supporting another block' using errcode = '23503';
  end if;

  delete from public.blocks where id = v_block.id;
  update public.dismantle_tickets
     set status = 'finished', finished_at = v_now
   where id = v_ticket.id;
  select s.* into strict v_state
    from public.player_world_state as s
   where s.world_id = p_world_id and s.player_id = v_actor;

  v_response := jsonb_build_object(
    'world_id', p_world_id,
    'ticket_id', p_ticket_id,
    'removed_block_id', v_block.id,
    'progress', private.state_json(v_state),
    'server_now', v_now,
    'replayed', false
  );
  insert into public.idempotent_operations (
    world_id, player_id, operation_key, operation_kind, request_hash,
    status, response, created_at, completed_at
  ) values (
    p_world_id, v_actor, p_idempotency_key, 'dismantle-finish', v_hash,
    'completed', v_response, v_now, v_now
  );
  return v_response;
end;
$$;

revoke execute on function public.bootstrap_player(uuid) from public, anon;
revoke execute on function public.get_nearby_blocks(uuid, integer, integer, integer) from public, anon;
revoke execute on function public.get_public_profiles(text[]) from public, anon;
revoke execute on function public.commit_world_actions(uuid, uuid, jsonb) from public, anon;
revoke execute on function public.settle_production(uuid) from public, anon;
revoke execute on function public.start_manual_production(uuid, uuid) from public, anon;
revoke execute on function public.complete_manual_production(uuid, uuid, uuid) from public, anon;
revoke execute on function public.start_dismantle(uuid, uuid, uuid) from public, anon;
revoke execute on function public.cancel_dismantle(uuid, uuid) from public, anon;
revoke execute on function public.finish_dismantle(uuid, uuid, uuid) from public, anon;

grant execute on function public.bootstrap_player(uuid) to authenticated;
grant execute on function public.get_nearby_blocks(uuid, integer, integer, integer) to authenticated;
grant execute on function public.get_public_profiles(text[]) to authenticated;
grant execute on function public.commit_world_actions(uuid, uuid, jsonb) to authenticated;
grant execute on function public.settle_production(uuid) to authenticated;
grant execute on function public.start_manual_production(uuid, uuid) to authenticated;
grant execute on function public.complete_manual_production(uuid, uuid, uuid) to authenticated;
grant execute on function public.start_dismantle(uuid, uuid, uuid) to authenticated;
grant execute on function public.cancel_dismantle(uuid, uuid) to authenticated;
grant execute on function public.finish_dismantle(uuid, uuid, uuid) to authenticated;

comment on function public.bootstrap_player(uuid) is
  'Creates the allow-listed public profile, exact initial grant, and unique bay slot atomically.';
comment on function public.commit_world_actions(uuid, uuid, jsonb) is
  'Atomic, idempotent max-24 action commit. Coordinates, zones, support, ownership, and inventory are server validated.';
comment on function public.start_dismantle(uuid, uuid, uuid) is
  'Starts a DB-clock 2.5 second foreign-public-block hold and invalidates prior unfinished holds.';

commit;
