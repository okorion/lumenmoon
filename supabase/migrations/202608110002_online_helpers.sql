begin;

create or replace function private.require_actor()
returns uuid
language plpgsql
stable
security invoker
set search_path = pg_catalog, auth
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'anonymous authentication required' using errcode = '42501';
  end if;
  return v_actor;
end;
$$;

create or replace function private.random_public_tag()
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, extensions
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(4);
begin
  return '#'
    || substr(v_alphabet, (get_byte(v_bytes, 0) % 32) + 1, 1)
    || substr(v_alphabet, (get_byte(v_bytes, 1) % 32) + 1, 1)
    || substr(v_alphabet, (get_byte(v_bytes, 2) % 32) + 1, 1)
    || substr(v_alphabet, (get_byte(v_bytes, 3) % 32) + 1, 1);
end;
$$;

create or replace function private.random_nickname()
returns text
language sql
volatile
security invoker
set search_path = pg_catalog
as $$
  select
    (array['고요한', '빛나는', '푸른', '따뜻한', '용감한', '느긋한'])[
      1 + floor(random() * 6)::integer
    ]
    || ' '
    || (array['여우', '수달', '참새', '고래', '토끼', '사슴'])[
      1 + floor(random() * 6)::integer
    ];
$$;

create or replace function private.random_emblem()
returns text
language sql
volatile
security invoker
set search_path = pg_catalog
as $$
  select (array['◆', '●', '▲', '■', '✦', '⬟'])[
    1 + floor(random() * 6)::integer
  ];
$$;

-- Matches src/domain/starterBay.ts exactly: square rings, 26-block spacing.
create or replace function private.starter_slot_geometry(p_slot integer)
returns table (origin_x integer, origin_z integer, rotation smallint)
language plpgsql
immutable
strict
security invoker
set search_path = pg_catalog
as $$
declare
  v_ring integer := 1;
  v_preceding integer := 0;
  v_offset integer;
  v_cursor integer;
  v_x integer;
  v_z integer;
  v_rotation smallint;
begin
  if p_slot < 0 then
    raise exception 'starter slot must be non-negative' using errcode = '22023';
  end if;

  while p_slot >= v_preceding + v_ring * 8 loop
    v_preceding := v_preceding + v_ring * 8;
    v_ring := v_ring + 1;
  end loop;

  v_offset := p_slot - v_preceding;
  v_cursor := v_offset;

  if v_cursor < v_ring + 1 then
    v_x := v_cursor;
    v_z := -v_ring;
    v_rotation := 0;
  else
    v_cursor := v_cursor - (v_ring + 1);
    if v_cursor < v_ring * 2 then
      v_x := v_ring;
      v_z := -v_ring + 1 + v_cursor;
      v_rotation := 1;
    else
      v_cursor := v_cursor - v_ring * 2;
      if v_cursor < v_ring * 2 then
        v_x := v_ring - 1 - v_cursor;
        v_z := v_ring;
        v_rotation := 2;
      else
        v_cursor := v_cursor - v_ring * 2;
        if v_cursor < v_ring * 2 then
          v_x := -v_ring;
          v_z := v_ring - 1 - v_cursor;
          v_rotation := 3;
        else
          v_cursor := v_cursor - v_ring * 2;
          v_x := -v_ring + 1 + v_cursor;
          v_z := -v_ring;
          v_rotation := 0;
        end if;
      end if;
    end if;
  end if;

  return query select v_x * 26, v_z * 26, v_rotation;
end;
$$;

create or replace function private.position_zone(
  p_world_id uuid,
  p_x integer,
  p_z integer
)
returns table (zone text, slot_index integer, owner_id uuid)
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, private
as $$
declare
  v_capacity integer;
  v_origin_x integer;
  v_origin_z integer;
  v_rotation smallint;
  v_dx integer;
  v_dz integer;
  v_lx integer;
  v_lz integer;
  v_owner uuid;
begin
  if abs(p_x) <= 6 and abs(p_z) <= 6 then
    return query select 'mission'::text, null::integer, null::uuid;
    return;
  end if;

  select w.starter_slot_capacity
    into v_capacity
    from public.worlds as w
   where w.id = p_world_id and w.enabled;
  if v_capacity is null then
    raise exception 'world is unavailable' using errcode = '22023';
  end if;

  for v_slot in 0..(v_capacity - 1) loop
    select g.origin_x, g.origin_z, g.rotation
      into v_origin_x, v_origin_z, v_rotation
      from private.starter_slot_geometry(v_slot) as g;
    v_dx := p_x - v_origin_x;
    v_dz := p_z - v_origin_z;

    if abs(v_dx) <= 18 and abs(v_dz) <= 18 then
      if v_rotation = 0 then
        v_lx := v_dx;
        v_lz := v_dz;
      elsif v_rotation = 1 then
        v_lx := v_dz;
        v_lz := -v_dx;
      elsif v_rotation = 2 then
        v_lx := -v_dx;
        v_lz := -v_dz;
      else
        v_lx := -v_dz;
        v_lz := v_dx;
      end if;

      select s.player_id
        into v_owner
        from public.player_world_state as s
       where s.world_id = p_world_id and s.starter_slot = v_slot;

      -- Spawn platform, path, and their vertical columns are immutable.
      if (v_lx between -1 and 1 and v_lz between -4 and -3)
        or (v_lx = 0 and v_lz between 3 and 16) then
        return query select 'system'::text, v_slot, v_owner;
        return;
      end if;

      -- Producer's 8 guides plus the 12-cell upgrade perimeter.
      if (v_lx between 3 and 4 and v_lz between -1 and 0)
        or (
          v_lx between 2 and 5 and v_lz between -2 and 1
          and (v_lx in (2, 5) or v_lz in (-2, 1))
        ) then
        return query select 'producer'::text, v_slot, v_owner;
        return;
      end if;

      if v_lx between -2 and 5 and v_lz between -2 and 2 then
        return query select 'personal'::text, v_slot, v_owner;
        return;
      end if;
    end if;
  end loop;

  return query select 'public'::text, null::integer, null::uuid;
end;
$$;

create or replace function private.guide_at(
  p_slot integer,
  p_x integer,
  p_y integer,
  p_z integer
)
returns table (
  guide_group text,
  expected_kind public.block_kind,
  expected_rotation smallint
)
language plpgsql
immutable
strict
security invoker
set search_path = pg_catalog, public, private
as $$
declare
  v_origin_x integer;
  v_origin_z integer;
  v_slot_rotation smallint;
  v_dx integer;
  v_dz integer;
  v_lx integer;
  v_lz integer;
  v_local_rotation smallint := 0;
  v_group text;
  v_kind public.block_kind;
begin
  select g.origin_x, g.origin_z, g.rotation
    into v_origin_x, v_origin_z, v_slot_rotation
    from private.starter_slot_geometry(p_slot) as g;
  v_dx := p_x - v_origin_x;
  v_dz := p_z - v_origin_z;

  if v_slot_rotation = 0 then
    v_lx := v_dx;
    v_lz := v_dz;
  elsif v_slot_rotation = 1 then
    v_lx := v_dz;
    v_lz := -v_dx;
  elsif v_slot_rotation = 2 then
    v_lx := -v_dx;
    v_lz := -v_dz;
  else
    v_lx := -v_dz;
    v_lz := v_dx;
  end if;

  if p_y = 1 and v_lx between -1 and 1 and v_lz between -1 and 1 then
    v_group := 'base';
    v_kind := 'cube';
  elsif p_y = 2 and v_lx = 0 and v_lz = -1 then
    v_group := 'base';
    v_kind := 'light';
  elsif p_y = 2 and (
    (v_lx = -1 and v_lz in (-1, 0)) or (v_lx = 1 and v_lz = -1)
  ) then
    v_group := 'base';
    v_kind := 'cube';
  elsif p_y = 3 and v_lz = -1 and v_lx in (-1, 1) then
    v_group := 'base';
    v_kind := 'stair';
    v_local_rotation := case when v_lx = -1 then 1 else 3 end;
  elsif p_y = 2 and v_lx = 1 and v_lz = 0 then
    v_group := 'base';
    v_kind := 'stair';
    v_local_rotation := 2;
  elsif p_y = 1 and v_lx between 3 and 4 and v_lz between -1 and 0 then
    v_group := 'producer';
    v_kind := 'cube';
  elsif p_y = 2 and v_lz = -1 and v_lx in (3, 4) then
    v_group := 'producer';
    v_kind := 'cube';
  elsif p_y = 2 and v_lx = 3 and v_lz = 0 then
    v_group := 'producer';
    v_kind := 'stair';
    v_local_rotation := 1;
  elsif p_y = 2 and v_lx = 4 and v_lz = 0 then
    v_group := 'producer';
    v_kind := 'light';
  elsif p_y = 1
    and v_lx between 2 and 5 and v_lz between -2 and 1
    and (v_lx in (2, 5) or v_lz in (-2, 1)) then
    v_group := 'upgrade';
    v_kind := case
      when (v_lx = 5 and v_lz = -1) or (v_lx = 3 and v_lz = 1)
        then 'light'::public.block_kind
      else 'cube'::public.block_kind
    end;
  else
    return;
  end if;

  return query
    select v_group, v_kind, ((v_local_rotation + v_slot_rotation) % 4)::smallint;
end;
$$;

-- Deterministic client-rendered blocks are not duplicated in public.blocks,
-- but their exact cells remain authoritative and immutable on the server.
create or replace function private.is_deterministic_system_cell(
  p_world_id uuid,
  p_x integer,
  p_y integer,
  p_z integer
)
returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, private
as $$
declare
  v_capacity integer;
  v_origin_x integer;
  v_origin_z integer;
  v_rotation smallint;
  v_dx integer;
  v_dz integer;
  v_lx integer;
  v_lz integer;
begin
  if p_y <> 0 then
    return false;
  end if;
  if p_x between -12 and 12 and p_z between -12 and 15 then
    return true;
  end if;

  select w.starter_slot_capacity into v_capacity
    from public.worlds as w
   where w.id = p_world_id and w.enabled;
  if v_capacity is null then
    raise exception 'world is unavailable' using errcode = '22023';
  end if;

  for v_slot in 0..(v_capacity - 1) loop
    select g.origin_x, g.origin_z, g.rotation
      into v_origin_x, v_origin_z, v_rotation
      from private.starter_slot_geometry(v_slot) as g;
    v_dx := p_x - v_origin_x;
    v_dz := p_z - v_origin_z;

    if v_rotation = 0 then
      v_lx := v_dx;
      v_lz := v_dz;
    elsif v_rotation = 1 then
      v_lx := v_dz;
      v_lz := -v_dx;
    elsif v_rotation = 2 then
      v_lx := -v_dx;
      v_lz := -v_dz;
    else
      v_lx := -v_dz;
      v_lz := v_dx;
    end if;

    if (v_lx between -2 and 5 and v_lz between -2 and 2)
      or (v_lx between -1 and 1 and v_lz between -4 and -3)
      or (v_lx = 0 and v_lz between 3 and 16) then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

create or replace function private.count_filled_guides(
  p_world_id uuid,
  p_player_id uuid,
  p_slot integer,
  p_group text
)
returns integer
language sql
stable
security invoker
set search_path = pg_catalog, public, private
as $$
  select count(*)::integer
    from public.blocks as b
   where b.world_id = p_world_id
     and b.creator_id = p_player_id
     and exists (
       select 1
         from private.guide_at(p_slot, b.x, b.y, b.z) as g
        where g.guide_group = p_group
     );
$$;

create or replace function private.state_json(p_state public.player_world_state)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'starter_slot', p_state.starter_slot,
    'inventory', p_state.inventory,
    'initial_grant_claimed', p_state.initial_grant_claimed,
    'base_completed', p_state.base_completed,
    'base_completed_at', p_state.base_completed_at,
    'producer_completed', p_state.producer_completed,
    'producer_completed_at', p_state.producer_completed_at,
    'trial_reward_claimed', p_state.trial_reward_claimed,
    'production_level', p_state.production_level,
    'producer_upgrade_completed_at', p_state.producer_upgrade_completed_at,
    'last_settled_at', p_state.last_settled_at,
    'manual_production_at', to_jsonb(p_state.manual_production_at)
  );
$$;

create or replace function private.block_public_json(p_block public.blocks)
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
    'chunk_z', p_block.chunk_z,
    'kind', p_block.kind,
    'rotation', p_block.rotation,
    'color_index', p_block.color_index,
    'creator_public_tag', p_block.creator_public_tag,
    'nickname_snapshot', p_block.nickname_snapshot,
    'creator_emblem', p_block.creator_emblem,
    'zone', p_block.zone,
    'support_id', p_block.support_id,
    'created_at', p_block.created_at
  );
$$;

create or replace function private.production_operational(
  p_world_id uuid,
  p_player_id uuid,
  p_state public.player_world_state
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, private
as $$
  select p_state.trial_reward_claimed
    and private.count_filled_guides(
      p_world_id,
      p_player_id,
      p_state.starter_slot,
      'producer'
    ) >= 8;
$$;

-- Caller holds the player_world_state row lock. All elapsed time comes from a
-- DB timestamp passed by the RPC; no client timestamp participates.
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
         last_settled_at = last_settled_at + v_interval * v_elapsed_slots,
         updated_at = p_now
   where world_id = p_world_id and player_id = p_player_id;
  return v_produced;
end;
$$;

create or replace function private.request_hash(p_value jsonb)
returns bytea
language sql
immutable
strict
security invoker
set search_path = pg_catalog, extensions
as $$
  select extensions.digest(convert_to(p_value::text, 'UTF8'), 'sha256');
$$;

revoke execute on all functions in schema private from public, anon, authenticated;

commit;
