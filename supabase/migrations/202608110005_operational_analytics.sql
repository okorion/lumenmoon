begin;

-- These counters describe authoritative game transactions, not client analytics.
-- They are updated inside the same DB transaction as the existing RPC mutation and
-- are never written by a separate browser request.
alter table public.player_world_state
  add column last_joined_at timestamptz not null default clock_timestamp(),
  add column join_count bigint not null default 1 check (join_count >= 1),
  add column total_blocks_placed bigint not null default 0 check (total_blocks_placed >= 0),
  add column total_own_blocks_removed bigint not null default 0
    check (total_own_blocks_removed >= 0),
  add column total_foreign_blocks_removed bigint not null default 0
    check (total_foreign_blocks_removed >= 0),
  add column total_automatic_produced bigint not null default 0
    check (total_automatic_produced >= 0),
  add column total_manual_produced bigint not null default 0
    check (total_manual_produced >= 0);

-- Existing installations can recover only the rows that still exist and the
-- rolling manual-production timestamps. Fresh installations start at zero and
-- remain exact from their first mutation.
update public.player_world_state as state
   set last_joined_at = state.created_at,
       total_blocks_placed = (
         select count(*)
           from public.blocks as block
          where block.world_id = state.world_id
            and block.creator_id = state.player_id
       ),
       total_manual_produced = cardinality(state.manual_production_at);

-- Automatic production has no durable row of its own, so retain its exact
-- produced count while preserving the original DB-clock settlement contract.
create or replace function private.settle_locked_production(
  p_world_id uuid,
  p_player_id uuid,
  p_now timestamptz
)
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, private
as $$
declare
  v_state public.player_world_state%rowtype;
  v_interval interval;
  v_interval_seconds numeric;
  v_elapsed_slots integer;
  v_capacity integer;
  v_produced integer;
begin
  select s.* into strict v_state
    from public.player_world_state as s
   where s.world_id = p_world_id and s.player_id = p_player_id
   for update;

  if not private.production_operational(p_world_id, p_player_id, v_state) then
    update public.player_world_state
       set last_settled_at = greatest(last_settled_at, p_now),
           updated_at = greatest(updated_at, p_now)
     where world_id = p_world_id and player_id = p_player_id;
    return 0;
  end if;

  v_interval := case v_state.production_level
    when 2 then interval '2 hours'
    else interval '3 hours'
  end;
  v_interval_seconds := extract(epoch from v_interval);
  v_elapsed_slots := greatest(
    0,
    floor(extract(epoch from (p_now - v_state.last_settled_at)) / v_interval_seconds)::integer
  );

  if v_elapsed_slots = 0 then
    return 0;
  end if;

  v_capacity := greatest(0, 36 - v_state.inventory);
  v_produced := least(v_elapsed_slots, v_capacity);

  update public.player_world_state
     set inventory = inventory + v_produced,
         total_automatic_produced = total_automatic_produced + v_produced,
         last_settled_at = last_settled_at + v_interval * v_elapsed_slots,
         updated_at = p_now
   where world_id = p_world_id and player_id = p_player_id;
  return v_produced;
end;
$$;

create or replace function private.count_authoritative_block_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    if new.creator_id = v_actor then
      update public.player_world_state
         set total_blocks_placed = total_blocks_placed + 1
       where world_id = new.world_id and player_id = v_actor;
    end if;
    return new;
  end if;

  update public.player_world_state
     set total_own_blocks_removed = total_own_blocks_removed
           + case when old.creator_id = v_actor then 1 else 0 end,
         total_foreign_blocks_removed = total_foreign_blocks_removed
           + case when old.creator_id <> v_actor then 1 else 0 end
   where world_id = old.world_id and player_id = v_actor;
  return old;
end;
$$;

create trigger count_authoritative_block_change
after insert or delete on public.blocks
for each row execute function private.count_authoritative_block_change();

create or replace function private.count_completed_manual_production()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.player_world_state
     set total_manual_produced = total_manual_produced + 1
   where world_id = new.world_id and player_id = new.player_id;
  return new;
end;
$$;

create trigger count_completed_manual_production
after insert on public.idempotent_operations
for each row
when (new.operation_kind = 'manual-complete' and new.status = 'completed')
execute function private.count_completed_manual_production();

-- Re-declare bootstrap so an ordinary successful bootstrap also records a
-- coarse authoritative visit. No additional client request is introduced.
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
  v_is_new_state boolean := false;
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
        if exists (select 1 from public.profiles where user_id = v_actor) then
          select p.* into strict v_profile
            from public.profiles as p where p.user_id = v_actor;
          exit;
        end if;
      end;
    end loop;
  end if;

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
      last_joined_at,
      join_count,
      created_at,
      updated_at
    )
    values (p_world_id, v_actor, v_slot, 24, true, v_now, v_now, 1, v_now, v_now)
    returning * into v_state;
    v_is_new_state := true;
  end if;

  if not v_is_new_state then
    update public.player_world_state
       set last_joined_at = v_now,
           join_count = join_count + case
             when last_joined_at < v_now - interval '30 minutes' then 1
             else 0
           end
     where world_id = p_world_id and player_id = v_actor
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

-- Only aggregated views are provided. Neither view emits auth UID, public ID,
-- nickname, coordinates, block IDs, or any client event payload.
create view private.operator_world_metrics
with (security_invoker = true)
as
select world.id as world_id,
       world.slug as world_slug,
       players.player_count,
       players.returning_player_count,
       players.confirmed_join_count,
       players.first_joined_at,
       players.last_joined_at,
       players.base_completed_players,
       players.producer_completed_players,
       players.producer_upgraded_players,
       players.total_blocks_placed,
       players.total_own_blocks_removed,
       players.total_foreign_blocks_removed,
       players.total_automatic_produced,
       players.total_manual_produced,
       missions.mission_contributor_count,
       missions.completed_mission_count
  from public.worlds as world
  cross join lateral (
    select count(*)::bigint as player_count,
           count(*) filter (where state.join_count > 1)::bigint
             as returning_player_count,
           coalesce(sum(state.join_count), 0)::bigint as confirmed_join_count,
           min(state.created_at) as first_joined_at,
           max(state.last_joined_at) as last_joined_at,
           count(*) filter (where state.base_completed)::bigint
             as base_completed_players,
           count(*) filter (where state.producer_completed)::bigint
             as producer_completed_players,
           count(*) filter (where state.production_level = 2)::bigint
             as producer_upgraded_players,
           coalesce(sum(state.total_blocks_placed), 0)::bigint
             as total_blocks_placed,
           coalesce(sum(state.total_own_blocks_removed), 0)::bigint
             as total_own_blocks_removed,
           coalesce(sum(state.total_foreign_blocks_removed), 0)::bigint
             as total_foreign_blocks_removed,
           coalesce(sum(state.total_automatic_produced), 0)::bigint
             as total_automatic_produced,
           coalesce(sum(state.total_manual_produced), 0)::bigint
             as total_manual_produced
      from public.player_world_state as state
     where state.world_id = world.id
  ) as players
  cross join lateral (
    select count(distinct contribution.contributor_id)::bigint
             as mission_contributor_count,
           (
             select count(*)::bigint
               from public.mission_instances as instance
              where instance.world_id = world.id
                and instance.status = 'completed'
           ) as completed_mission_count
      from public.mission_contributions as contribution
     where contribution.world_id = world.id
  ) as missions;

create view private.operator_mission_metrics
with (security_invoker = true)
as
select instance.world_id,
       template.template_key,
       template.name as mission_name,
       instance.layer,
       instance.status,
       instance.started_at,
       instance.completed_at,
       case when instance.completed_at is null then null
            else extract(epoch from instance.completed_at - instance.started_at)::bigint
       end as completion_seconds,
       count(contribution.id)::bigint as canonical_contribution_count,
       count(distinct contribution.contributor_id)::bigint as unique_contributor_count
  from public.mission_instances as instance
  join public.mission_templates as template on template.id = instance.template_id
  left join public.mission_contributions as contribution
    on contribution.mission_instance_id = instance.id
 group by instance.id, instance.world_id, template.template_key, template.name,
          instance.layer, instance.status, instance.started_at, instance.completed_at;

revoke all on table private.operator_world_metrics from public, anon, authenticated;
revoke all on table private.operator_mission_metrics from public, anon, authenticated;
grant usage on schema private to service_role;
grant select on table private.operator_world_metrics to service_role;
grant select on table private.operator_mission_metrics to service_role;

revoke execute on function private.count_authoritative_block_change()
  from public, anon, authenticated;
revoke execute on function private.count_completed_manual_production()
  from public, anon, authenticated;
revoke execute on function public.bootstrap_player(uuid) from public, anon;
grant execute on function public.bootstrap_player(uuid) to authenticated;

comment on column public.player_world_state.last_joined_at is
  'Last successful bootstrap; joins separated by 30 minutes increment join_count.';
comment on column public.player_world_state.total_blocks_placed is
  'Authoritative block inserts counted in the same transaction as the validated game mutation.';
comment on view private.operator_world_metrics is
  'Service-role-only aggregate of canonical world operations; contains no public identity or raw analytics.';
comment on view private.operator_mission_metrics is
  'Service-role-only per-mission aggregate using canonical contribution rows.';

commit;
