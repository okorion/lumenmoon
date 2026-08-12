begin;

-- Free build is deliberately isolated from the mission/onboarding economy. A
-- player may enter either mode without free-mode stock changing mission stock.
create table public.free_mode_player_state (
  world_id uuid not null references public.worlds(id) on delete cascade,
  player_id uuid not null references public.profiles(user_id) on delete cascade,
  inventory smallint not null default 30 check (inventory between 0 and 100),
  initial_grant_claimed boolean not null default true,
  last_settled_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (world_id, player_id),
  constraint free_mode_initial_grant_is_one_time check (initial_grant_claimed)
);

create table public.free_mode_blocks (
  id uuid primary key,
  world_id uuid not null references public.worlds(id) on delete cascade,
  x integer not null check (x between -512 and 512),
  y integer not null check (y between 1 and 32760),
  z integer not null check (z between -512 and 512),
  chunk_x integer generated always as (floor(x::numeric / 16)::integer) stored,
  chunk_y integer generated always as (floor(y::numeric / 16)::integer) stored,
  chunk_z integer generated always as (floor(z::numeric / 16)::integer) stored,
  kind public.block_kind not null,
  rotation smallint not null check (rotation between 0 and 3),
  color_index smallint not null check (color_index between 0 and 11),
  creator_id uuid not null references public.profiles(user_id) on delete restrict,
  creator_public_tag text not null,
  nickname_snapshot text not null,
  creator_emblem text not null,
  support_id uuid references public.free_mode_blocks(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  unique (world_id, x, y, z),
  constraint free_mode_blocks_support_not_self check (support_id is null or support_id <> id)
);

create index free_mode_blocks_world_chunk_3d_idx
  on public.free_mode_blocks (
    world_id, chunk_x, chunk_y, chunk_z, created_at, id
  );
create index free_mode_blocks_creator_idx
  on public.free_mode_blocks (world_id, creator_id);
create index free_mode_blocks_support_idx
  on public.free_mode_blocks (support_id)
  where support_id is not null;

create table public.free_mode_operations (
  world_id uuid not null references public.worlds(id) on delete cascade,
  player_id uuid not null references public.profiles(user_id) on delete cascade,
  operation_key uuid not null,
  request_hash bytea not null,
  response jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz not null default clock_timestamp(),
  primary key (world_id, player_id, operation_key)
);
create index free_mode_operations_actor_created_idx
  on public.free_mode_operations (world_id, player_id, created_at desc);
create index free_mode_operations_completed_idx
  on public.free_mode_operations (completed_at);

alter table public.free_mode_player_state enable row level security;
alter table public.free_mode_blocks enable row level security;
alter table public.free_mode_operations enable row level security;

-- There are intentionally no browser table policies. Public identity and
-- mutations cross only the bounded SECURITY DEFINER RPC boundary below.
revoke all on table public.free_mode_player_state from anon, authenticated;
revoke all on table public.free_mode_blocks from anon, authenticated;
revoke all on table public.free_mode_operations from anon, authenticated;

-- 모드 선택 전에는 공개 프로필만 준비한다. 자유 재고와 미션 베이는
-- 각 모드를 실제로 선택한 RPC에서만 생성한다.
create function public.get_player_identity(
  p_world_id uuid default '00000000-0000-4000-8000-000000000001'::uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  v_actor uuid := private.require_actor();
  v_profile public.profiles%rowtype;
  v_now timestamptz := clock_timestamp();
  v_tag text;
begin
  if not exists (
    select 1 from public.worlds as world
     where world.id = p_world_id and world.enabled
  ) then
    raise exception 'world is unavailable' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('player-identity:' || v_actor::text, 0)
  );
  select profile.* into v_profile
    from public.profiles as profile where profile.user_id = v_actor;
  if not found then
    loop
      v_tag := private.random_public_tag();
      begin
        insert into public.profiles (
          user_id, public_tag, nickname, emblem, created_at
        ) values (
          v_actor, v_tag, private.random_nickname(),
          private.random_emblem(), v_now
        ) returning * into v_profile;
        exit;
      exception when unique_violation then
        select profile.* into v_profile
          from public.profiles as profile where profile.user_id = v_actor;
        exit when found;
      end;
    end loop;
  end if;
  return jsonb_build_object(
    'profile', jsonb_build_object(
      'public_tag', v_profile.public_tag,
      'nickname', v_profile.nickname,
      'emblem', v_profile.emblem
    ),
    'server_now', v_now
  );
end;
$$;

create function private.free_mode_progress_json(
  p_state public.free_mode_player_state
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'initial_grant_claimed', p_state.initial_grant_claimed,
    'inventory', p_state.inventory,
    'last_settled_at', p_state.last_settled_at
  );
$$;

create function private.free_mode_block_public_json(
  p_block public.free_mode_blocks
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'id', p_block.id,
    'world_id', p_block.world_id,
    'x', p_block.x,
    'y', p_block.y,
    'z', p_block.z,
    'chunk_x', p_block.chunk_x,
    'chunk_y', p_block.chunk_y,
    'chunk_z', p_block.chunk_z,
    'kind', p_block.kind,
    'rotation', p_block.rotation,
    'color_index', p_block.color_index,
    'creator_public_tag', p_block.creator_public_tag,
    'nickname_snapshot', p_block.nickname_snapshot,
    'creator_emblem', p_block.creator_emblem,
    'zone', 'public',
    'support_id', p_block.support_id,
    'source', 'free',
    'created_at', p_block.created_at,
    'removable_by_others_at', p_block.created_at + interval '72 hours'
  );
$$;

create function private.free_mode_position_is_protected(
  p_world_id uuid,
  p_x integer,
  p_y integer,
  p_z integer
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, private
as $$
  select
    -- Keep the shared free-mode spawn and its route to the central plaza clear
    -- at player height. Without this finite clearance, a single account can
    -- surround every new visitor with fewer than 100 protected blocks.
    (
      p_y between 1 and 2
      and (
        -- Slot 0 safe-spawn body clearance.
        (p_x between -1 and 1 and p_z between -30 and -28)
        -- Three-cell-wide route from spawn to the central plaza.
        or (p_x between -1 and 1 and p_z between -29 and 0)
        -- Central pad around world origin; finite and only player-high.
        or (p_x between -7 and 7 and p_z between -7 and 7)
      )
    )
    or
    -- Exact raised coordinates generated by createCentralOnlineSystemBlocks().
    -- Do not reserve an infinite center column: free building remains open
    -- above and around the actual immutable geometry.
    (
      (p_x = 0 and p_z = 0 and p_y between 1 and 8)
      or (p_y = 1 and abs(p_x) + abs(p_z) = 1)
      or (p_z = 0 and abs(p_x) = 1 and p_y in (2, 4, 6))
      or (p_x = -1 and p_y = 3 and p_z = 0)
      or (p_x = 0 and p_y = 4 and p_z = 1)
      or (p_x = 1 and p_y = 5 and p_z = 0)
      or (p_x = 0 and p_y = 6 and p_z = -1)
      or (p_y = 7 and abs(p_x) + abs(p_z) = 1)
    )
    -- Deterministic ground, starter platforms and paths have no mutable rows,
    -- so their exact coordinates must still be rejected server-side.
    or private.is_deterministic_system_cell(p_world_id, p_x, p_y, p_z);
$$;

create function private.ensure_free_mode_state(
  p_world_id uuid,
  p_actor uuid,
  p_now timestamptz
)
returns public.free_mode_player_state
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_state public.free_mode_player_state%rowtype;
  v_tag text;
begin
  if not exists (
    select 1 from public.worlds as world
     where world.id = p_world_id and world.enabled
  ) then
    raise exception 'world is unavailable' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('free-mode-bootstrap:' || p_actor::text, 0)
  );

  if not exists (
    select 1 from public.profiles as profile where profile.user_id = p_actor
  ) then
    loop
      v_tag := private.random_public_tag();
      begin
        insert into public.profiles (
          user_id, public_tag, nickname, emblem, created_at
        ) values (
          p_actor,
          v_tag,
          private.random_nickname(),
          private.random_emblem(),
          p_now
        );
        exit;
      exception when unique_violation then
        if exists (
          select 1 from public.profiles as profile
           where profile.user_id = p_actor
        ) then
          exit;
        end if;
      end;
    end loop;
  end if;

  insert into public.free_mode_player_state (
    world_id,
    player_id,
    inventory,
    initial_grant_claimed,
    last_settled_at,
    created_at,
    updated_at
  ) values (
    p_world_id, p_actor, 30, true, p_now, p_now, p_now
  ) on conflict (world_id, player_id) do nothing;

  select state.* into strict v_state
    from public.free_mode_player_state as state
   where state.world_id = p_world_id and state.player_id = p_actor;
  return v_state;
end;
$$;

create function private.settle_locked_free_mode_inventory(
  p_world_id uuid,
  p_actor uuid,
  p_now timestamptz
)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_state public.free_mode_player_state%rowtype;
  v_elapsed_hours integer;
  v_inventory smallint;
  v_produced integer := 0;
  v_last_settled_at timestamptz;
begin
  select state.* into v_state
    from public.free_mode_player_state as state
   where state.world_id = p_world_id and state.player_id = p_actor
   for update;
  if not found then
    raise exception 'free mode is not initialized' using errcode = '42501';
  end if;

  if v_state.inventory >= 100 then
    -- 조회·정산 RPC를 반복해도 UPDATE/WAL을 만들지 않는다. 가득 찬
    -- 동안의 시간을 비축하지 않는 규칙은 실제 100→99 place에서
    -- last_settled_at을 다시 시작하는 방식으로 보장한다.
    return 0;
  end if;

  v_elapsed_hours := greatest(
    0,
    floor(extract(epoch from (p_now - v_state.last_settled_at)) / 3600)::integer
  );
  if v_elapsed_hours = 0 then
    return 0;
  end if;

  v_inventory := least(100, v_state.inventory + v_elapsed_hours * 5)::smallint;
  v_produced := v_inventory - v_state.inventory;
  -- A full inventory never banks elapsed or partial time. Reaching the cap
  -- starts a fresh interval, so spending one block cannot grant it back early.
  v_last_settled_at := case
    when v_inventory >= 100 then p_now
    else v_state.last_settled_at + make_interval(hours => v_elapsed_hours)
  end;

  update public.free_mode_player_state
     set inventory = v_inventory,
         last_settled_at = v_last_settled_at,
         updated_at = greatest(updated_at, p_now)
   where world_id = p_world_id and player_id = p_actor;
  return v_produced;
end;
$$;

create function private.free_mode_overview_json(
  p_world_id uuid,
  p_state public.free_mode_player_state,
  p_produced integer,
  p_now timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, private
as $$
  select jsonb_build_object(
    'world_id', p_world_id,
    'progress', private.free_mode_progress_json(p_state),
    'max_inventory', 100,
    'grant_amount', 5,
    'grant_interval_ms', 3600000,
    'foreign_removal_age_ms', 259200000,
    'next_grant_in_ms', case
      when p_state.inventory >= 100 then null
      else greatest(
        0,
        ceil(extract(epoch from (
          p_state.last_settled_at + interval '1 hour' - p_now
        )) * 1000)::bigint
      )
    end,
    'produced', p_produced,
    'server_now', p_now
  );
$$;

create function public.get_free_mode_overview(
  p_world_id uuid default '00000000-0000-4000-8000-000000000001'::uuid
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
  v_state public.free_mode_player_state%rowtype;
  v_profile public.profiles%rowtype;
  v_world public.worlds%rowtype;
  v_produced integer;
begin
  perform private.ensure_free_mode_state(p_world_id, v_actor, v_now);
  v_produced := private.settle_locked_free_mode_inventory(
    p_world_id, v_actor, v_now
  );
  select state.* into strict v_state
    from public.free_mode_player_state as state
   where state.world_id = p_world_id and state.player_id = v_actor;
  select profile.* into strict v_profile
    from public.profiles as profile where profile.user_id = v_actor;
  select world.* into strict v_world
    from public.worlds as world where world.id = p_world_id;

  return private.free_mode_overview_json(
    p_world_id, v_state, v_produced, v_now
  ) || jsonb_build_object(
    'profile', jsonb_build_object(
      'public_tag', v_profile.public_tag,
      'nickname', v_profile.nickname,
      'emblem', v_profile.emblem
    ),
    'world', jsonb_build_object(
      'id', v_world.id,
      'slug', v_world.slug,
      'title', v_world.title
    )
  );
end;
$$;

create function public.settle_free_mode_inventory(p_world_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  v_actor uuid := private.require_actor();
  v_now timestamptz := clock_timestamp();
  v_state public.free_mode_player_state%rowtype;
  v_profile public.profiles%rowtype;
  v_produced integer;
begin
  perform private.ensure_free_mode_state(p_world_id, v_actor, v_now);
  v_produced := private.settle_locked_free_mode_inventory(
    p_world_id, v_actor, v_now
  );
  select state.* into strict v_state
    from public.free_mode_player_state as state
   where state.world_id = p_world_id and state.player_id = v_actor;
  select profile.* into strict v_profile
    from public.profiles as profile where profile.user_id = v_actor;

  return private.free_mode_overview_json(
    p_world_id, v_state, v_produced, v_now
  ) || jsonb_build_object(
    'profile', jsonb_build_object(
      'public_tag', v_profile.public_tag,
      'nickname', v_profile.nickname,
      'emblem', v_profile.emblem
    )
  );
end;
$$;

create function public.get_nearby_free_mode_blocks(
  p_world_id uuid,
  p_chunk_x integer,
  p_chunk_y integer,
  p_chunk_z integer,
  p_radius integer,
  p_vertical_radius integer
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
  v_blocks jsonb;
  v_count integer;
begin
  if p_chunk_x not between -32 and 32
    or p_chunk_y not between 0 and 2047
    or p_chunk_z not between -32 and 32 then
    raise exception 'chunk coordinate is outside world bounds' using errcode = '22023';
  end if;
  if p_radius not between 0 and 2 then
    raise exception 'horizontal chunk radius must be between 0 and 2' using errcode = '22023';
  end if;
  if p_vertical_radius not between 0 and 1 then
    raise exception 'vertical chunk radius must be between 0 and 1' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.free_mode_player_state as state
     where state.world_id = p_world_id and state.player_id = v_actor
  ) then
    raise exception 'free mode is not initialized' using errcode = '42501';
  end if;

  with nearby as materialized (
    select block as value
      from public.free_mode_blocks as block
     where block.world_id = p_world_id
       and block.chunk_x between p_chunk_x - p_radius and p_chunk_x + p_radius
       and block.chunk_y between p_chunk_y - p_vertical_radius and p_chunk_y + p_vertical_radius
       and block.chunk_z between p_chunk_z - p_radius and p_chunk_z + p_radius
     order by block.created_at, block.id
     limit 8193
  )
  select count(*)::integer,
         coalesce(
           jsonb_agg(
             private.free_mode_block_public_json(nearby.value)
             order by (nearby.value).created_at, (nearby.value).id
           ),
           '[]'::jsonb
         )
    into v_count, v_blocks
    from nearby;

  if v_count > 8192 then
    raise exception 'nearby block response exceeds 8192 rows' using errcode = '54000';
  end if;

  return jsonb_build_object(
    'world_id', p_world_id,
    'blocks', v_blocks,
    'block_count', v_count,
    'block_limit', 8192,
    'server_now', v_now
  );
end;
$$;

create function public.commit_free_mode_actions(
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
  v_existing public.free_mode_operations%rowtype;
  v_state public.free_mode_player_state%rowtype;
  v_profile public.profiles%rowtype;
  v_action jsonb;
  v_action_type text;
  v_count integer;
  v_chunk_count integer;
  v_block_id uuid;
  v_x integer;
  v_y integer;
  v_z integer;
  v_kind public.block_kind;
  v_rotation smallint;
  v_color smallint;
  v_support_id uuid;
  v_support public.free_mode_blocks%rowtype;
  v_block public.free_mode_blocks%rowtype;
  v_upserted jsonb := '[]'::jsonb;
  v_removed jsonb := '[]'::jsonb;
  v_response jsonb;
  v_produced integer;
begin
  if p_idempotency_key is null then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_actions) <> 'array' then
    raise exception 'actions must be a JSON array' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_actions);
  if v_count < 1 then
    raise exception 'exactly one free-mode action is required' using errcode = '22023';
  end if;
  if octet_length(p_actions::text) > 32768 then
    raise exception 'action payload exceeds 32768 bytes' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_actions) as item(value)
     where jsonb_typeof(item.value) = 'object'
       and item.value ? 'block_id'
     group by item.value ->> 'block_id'
    having count(*) > 1
  ) then
    raise exception 'each block id may appear only once per commit'
      using errcode = '22023';
  end if;
  if v_count <> 1 then
    raise exception 'exactly one free-mode action is required' using errcode = '22023';
  end if;

  v_hash := private.request_hash(
    jsonb_build_object('world_id', p_world_id, 'actions', p_actions)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'free-mode-commit:' || p_world_id::text || ':' || v_actor::text
        || ':' || p_idempotency_key::text,
      0
    )
  );

  -- The same key is guaranteed only for the documented 24-hour window.
  -- Delete an expired exact key before lookup so it cannot replay forever or
  -- collide with the new authoritative result at insert time.
  delete from public.free_mode_operations as expired
   where expired.world_id = p_world_id
     and expired.player_id = v_actor
     and expired.operation_key = p_idempotency_key
     and expired.completed_at <= v_now - interval '24 hours';

  select operation.* into v_existing
    from public.free_mode_operations as operation
   where operation.world_id = p_world_id
     and operation.player_id = v_actor
     and operation.operation_key = p_idempotency_key;
  if found then
    if v_existing.request_hash <> v_hash then
      raise exception 'idempotency key was used with a different request'
        using errcode = '22023';
    end if;
    return v_existing.response || jsonb_build_object('replayed', true);
  end if;

  -- Different idempotency keys from the same actor must not race past the
  -- rolling limit. This actor-scoped gate does not block other builders.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'free-mode-rate:' || p_world_id::text || ':' || v_actor::text,
      0
    )
  );

  -- Action keys are replayable for at least 24 hours. Each new commit
  -- opportunistically removes a bounded global batch so one-time anonymous
  -- players do not leave response rows forever. SKIP LOCKED avoids waiting on
  -- another mutation's journal row and the completed_at index bounds the scan.
  delete from public.free_mode_operations as expired
   where expired.ctid in (
     select operation.ctid
       from public.free_mode_operations as operation
       where operation.completed_at <= v_now - interval '24 hours'
       order by operation.completed_at
       limit 512
       for update skip locked
   );

  -- 즉시 회수로 재고가 복구되더라도 한 계정이 무한 place/remove 요청으로
  -- 원장과 DB 비용을 폭증시키지 못하게 최근 24시간 확정 작업을 제한한다.
  if (
    select count(*)
      from public.free_mode_operations as operation
     where operation.world_id = p_world_id
       and operation.player_id = v_actor
       and operation.created_at > v_now - interval '24 hours'
  ) >= 240 then
    raise exception 'free-mode daily mutation limit reached'
      using errcode = 'P0003';
  end if;

  perform private.ensure_free_mode_state(p_world_id, v_actor, v_now);
  v_produced := private.settle_locked_free_mode_inventory(
    p_world_id, v_actor, v_now
  );
  select state.* into strict v_state
    from public.free_mode_player_state as state
   where state.world_id = p_world_id and state.player_id = v_actor
   for update;
  select profile.* into strict v_profile
    from public.profiles as profile where profile.user_id = v_actor;

  for v_action in select value from jsonb_array_elements(p_actions) loop
    if jsonb_typeof(v_action) <> 'object' then
      raise exception 'each action must be an object' using errcode = '22023';
    end if;
    v_action_type := v_action ->> 'type';

    if v_action_type = 'place' then
      if (v_action - array[
        'type', 'block_id', 'x', 'y', 'z', 'kind', 'rotation',
        'color_index', 'support_id'
      ]) <> '{}'::jsonb then
        raise exception 'place action contains unsupported fields' using errcode = '22023';
      end if;
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
        or v_x is null or v_x not between -512 and 512
        or v_y is null or v_y not between 1 and 32760
        or v_z is null or v_z not between -512 and 512
        or v_kind is null
        or v_rotation is null or v_rotation not between 0 and 3
        or v_color is null or v_color not between 0 and 11 then
        raise exception 'place action is outside world or palette bounds'
          using errcode = '22023';
      end if;
      if v_state.inventory <= 0 then
        raise exception 'insufficient inventory' using errcode = '22023';
      end if;
      if private.free_mode_position_is_protected(
        p_world_id, v_x, v_y, v_z
      ) then
        raise exception 'protected zone cannot be modified'
          using errcode = '42501';
      end if;
      if v_y = 1 and not private.is_deterministic_system_cell(
        p_world_id, v_x, 0, v_z
      ) then
        raise exception 'ground cell does not exist at this coordinate'
          using errcode = '23503';
      end if;
      if v_y > 1 and v_support_id is null then
        raise exception 'free-mode blocks above ground require supportId'
          using errcode = '23503';
      end if;

      if v_support_id is not null then
        select block.* into v_support
          from public.free_mode_blocks as block
         where block.id = v_support_id
         for key share;
        if not found then
          -- The ground is deterministic client geometry and has no DB row.
          if v_y = 1 then
            v_support_id := null;
          else
            raise exception 'supportId does not exist in free mode'
              using errcode = '23503';
          end if;
        elsif v_support.world_id <> p_world_id
          or abs(v_support.x - v_x) + abs(v_support.y - v_y)
            + abs(v_support.z - v_z) <> 1 then
          raise exception 'supportId must reference an adjacent free-mode block'
            using errcode = '23503';
        end if;
      end if;

      -- Only builders targeting the same 16-cube chunk contend. Unsupported
      -- or malformed placements fail before this gate, so one bad actor cannot
      -- serialize every free-mode write in the world.
      perform pg_advisory_xact_lock(
        hashtextextended(
          'free-mode-chunk:' || p_world_id::text || ':'
            || floor(v_x::numeric / 16)::integer::text || ':'
            || floor(v_y::numeric / 16)::integer::text || ':'
            || floor(v_z::numeric / 16)::integer::text,
          0
        )
      );

      select count(*)::integer into v_chunk_count
        from public.free_mode_blocks as block
       where block.world_id = p_world_id
         and block.chunk_x = floor(v_x::numeric / 16)::integer
         and block.chunk_y = floor(v_y::numeric / 16)::integer
         and block.chunk_z = floor(v_z::numeric / 16)::integer;
      if v_chunk_count >= 100 then
        raise exception 'free-mode chunk has reached the 100-block limit'
          using errcode = '54000';
      end if;

      begin
        insert into public.free_mode_blocks (
          id, world_id, x, y, z, kind, rotation, color_index,
          creator_id, creator_public_tag, nickname_snapshot,
          creator_emblem, support_id, created_at
        ) values (
          v_block_id, p_world_id, v_x, v_y, v_z, v_kind,
          v_rotation, v_color, v_actor, v_profile.public_tag,
          v_profile.nickname, v_profile.emblem, v_support_id, v_now
        ) returning * into v_block;
      exception when unique_violation then
        raise exception 'block id or coordinate is already occupied'
          using errcode = '23505';
      end;

      update public.free_mode_player_state
         set inventory = inventory - 1,
             last_settled_at = case
               when inventory >= 100 then v_now
               else last_settled_at
             end,
             updated_at = v_now
       where world_id = p_world_id and player_id = v_actor
       returning * into v_state;
      v_upserted := v_upserted || jsonb_build_array(
        private.free_mode_block_public_json(v_block)
      );

    elsif v_action_type = 'remove' then
      if (v_action - array['type', 'block_id']) <> '{}'::jsonb then
        raise exception 'remove action contains unsupported fields' using errcode = '22023';
      end if;
      begin
        v_block_id := (v_action ->> 'block_id')::uuid;
      exception when others then
        raise exception 'invalid remove action payload' using errcode = '22023';
      end;
      if v_block_id is null then
        raise exception 'invalid remove action payload' using errcode = '22023';
      end if;

      select block.* into v_block
        from public.free_mode_blocks as block
       where block.world_id = p_world_id and block.id = v_block_id
       for update;
      if not found then
        raise exception 'block does not exist' using errcode = 'P0002';
      end if;
      if v_block.creator_id <> v_actor
        and v_now < v_block.created_at + interval '72 hours' then
        raise exception 'another player block is protected for 72 hours'
          using errcode = 'P0004';
      end if;
      if v_block.creator_id <> v_actor and exists (
        select 1 from public.free_mode_blocks as child
         where child.world_id = p_world_id
           and child.support_id = v_block.id
      ) then
        raise exception 'block is supporting another block'
          using errcode = 'P0005';
      end if;

      if v_block.creator_id = v_actor then
        -- An owner can always reclaim their own block. Detach every free-mode
        -- child in the same transaction and return those authoritative
        -- updates so the client does not retain a stale support reference.
        for v_support in
          update public.free_mode_blocks as child
             set support_id = null
           where child.world_id = p_world_id
             and child.support_id = v_block.id
           returning child.*
        loop
          v_upserted := v_upserted || jsonb_build_array(
            private.free_mode_block_public_json(v_support)
          );
        end loop;
      end if;

      delete from public.free_mode_blocks where id = v_block.id;
      if v_block.creator_id = v_actor then
        update public.free_mode_player_state
           set inventory = least(100, inventory + 1),
               last_settled_at = case
                 when inventory = 99 then v_now
                 else last_settled_at
               end,
               updated_at = v_now
         where world_id = p_world_id and player_id = v_actor
         returning * into v_state;
      end if;
      v_removed := v_removed || to_jsonb(v_block.id);
    else
      raise exception 'unsupported action type' using errcode = '22023';
    end if;
  end loop;

  v_response := jsonb_build_object(
    'world_id', p_world_id,
    'idempotency_key', p_idempotency_key,
    'upserted_blocks', v_upserted,
    'removed_block_ids', v_removed,
    'progress', private.free_mode_progress_json(v_state),
    'produced', v_produced,
    'server_now', v_now,
    'replayed', false
  );

  insert into public.free_mode_operations (
    world_id, player_id, operation_key, request_hash, response,
    created_at, completed_at
  ) values (
    p_world_id, v_actor, p_idempotency_key, v_hash, v_response,
    v_now, v_now
  );
  return v_response;
end;
$$;

revoke execute on function public.get_player_identity(uuid) from public, anon;
revoke execute on function public.get_free_mode_overview(uuid)
  from public, anon;
revoke execute on function public.settle_free_mode_inventory(uuid)
  from public, anon;
revoke execute on function public.get_nearby_free_mode_blocks(
  uuid, integer, integer, integer, integer, integer
) from public, anon;
revoke execute on function public.commit_free_mode_actions(uuid, uuid, jsonb)
  from public, anon;

grant execute on function public.get_player_identity(uuid) to authenticated;
grant execute on function public.get_free_mode_overview(uuid)
  to authenticated;
grant execute on function public.settle_free_mode_inventory(uuid)
  to authenticated;
grant execute on function public.get_nearby_free_mode_blocks(
  uuid, integer, integer, integer, integer, integer
) to authenticated;
grant execute on function public.commit_free_mode_actions(uuid, uuid, jsonb)
  to authenticated;

revoke execute on function private.free_mode_progress_json(
  public.free_mode_player_state
) from public, anon, authenticated;
revoke execute on function private.free_mode_block_public_json(
  public.free_mode_blocks
) from public, anon, authenticated;
revoke execute on function private.free_mode_position_is_protected(
  uuid, integer, integer, integer
) from public, anon, authenticated;
revoke execute on function private.free_mode_overview_json(
  uuid, public.free_mode_player_state, integer, timestamptz
) from public, anon, authenticated;
revoke execute on function private.ensure_free_mode_state(
  uuid, uuid, timestamptz
) from public, anon, authenticated;
revoke execute on function private.settle_locked_free_mode_inventory(
  uuid, uuid, timestamptz
) from public, anon, authenticated;

comment on table public.free_mode_player_state is
  'Isolated free-build stock: exact one-time 30 grant, DB-clock +5/hour, cap 100.';
comment on table public.free_mode_blocks is
  'Free-build blocks. Owners remove immediately; others only after created_at + 72 hours.';
comment on table public.free_mode_operations is
  'Free-build idempotency responses retained for at least 24 hours and pruned in bounded batches by later successful commits.';
comment on function public.commit_free_mode_actions(uuid, uuid, jsonb) is
  'Atomic idempotent free-build commit. Exactly one action/32KiB; server validates stock, coordinates, palette, support and the 72-hour ownership window.';

commit;
