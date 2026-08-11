begin;

create table public.mission_templates (
  id uuid primary key,
  template_key text not null,
  version smallint not null default 1 check (version > 0),
  name text not null,
  slot_count smallint not null default 24 check (slot_count = 24),
  palette smallint[] not null,
  layer_height smallint not null default 7 check (layer_height between 1 and 24),
  next_template_id uuid references public.mission_templates(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique (template_key, version),
  constraint mission_templates_five_color_palette check (
    cardinality(palette) = 5
    and array_ndims(palette) = 1
    and array_lower(palette, 1) = 1
    and array_upper(palette, 1) = 5
    and palette[1] <> all(palette[2:5])
    and palette[2] <> all(palette[3:5])
    and palette[3] <> all(palette[4:5])
    and palette[4] <> palette[5]
    and palette <@ array[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]::smallint[]
  )
);

create table public.mission_template_slots (
  template_id uuid not null references public.mission_templates(id) on delete cascade,
  slot_index smallint not null check (slot_index between 0 and 23),
  local_x smallint not null check (local_x between -32 and 32),
  local_y smallint not null check (local_y between 0 and 32),
  local_z smallint not null check (local_z between -32 and 32),
  kind public.block_kind not null,
  rotation smallint not null default 0 check (rotation between 0 and 3),
  primary key (template_id, slot_index),
  unique (template_id, local_x, local_y, local_z)
);

create table public.mission_instances (
  id uuid primary key default extensions.gen_random_uuid(),
  world_id uuid not null references public.worlds(id) on delete cascade,
  template_id uuid not null references public.mission_templates(id) on delete restrict,
  layer integer not null check (layer > 0),
  origin_x integer not null check (origin_x between -480 and 480),
  origin_y integer not null check (origin_y between 0 and 32755),
  origin_z integer not null check (origin_z between -480 and 480),
  rotation smallint not null check (rotation between 0 and 3),
  palette_seed integer not null default 0,
  status text not null default 'active' check (status in ('active', 'completed')),
  filled_slots smallint not null default 0 check (filled_slots between 0 and 24),
  total_slots smallint not null default 24 check (total_slots = 24),
  stage_percent smallint not null default 0 check (stage_percent in (0, 25, 50, 75, 100)),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (world_id, layer),
  constraint mission_instances_completion_state check (
    (status = 'active' and completed_at is null and filled_slots < total_slots and stage_percent < 100)
    or
    (status = 'completed' and completed_at is not null and filled_slots = total_slots and stage_percent = 100)
  )
);

create unique index mission_instances_one_active_per_world_idx
  on public.mission_instances (world_id)
  where status = 'active';

create table public.mission_contributions (
  id uuid primary key default extensions.gen_random_uuid(),
  world_id uuid not null references public.worlds(id) on delete cascade,
  mission_instance_id uuid not null references public.mission_instances(id) on delete restrict,
  template_id uuid not null references public.mission_templates(id) on delete restrict,
  slot_index smallint not null,
  block_id uuid not null unique references public.blocks(id) on delete restrict,
  contributor_id uuid not null references public.profiles(user_id) on delete restrict,
  creator_public_tag text not null,
  nickname_snapshot text not null,
  creator_emblem text not null,
  palette_index smallint not null check (palette_index between 0 and 4),
  color_index smallint not null check (color_index between 0 and 11),
  created_at timestamptz not null default clock_timestamp(),
  unique (mission_instance_id, slot_index),
  foreign key (template_id, slot_index)
    references public.mission_template_slots(template_id, slot_index)
    on delete restrict
);

create index mission_contributions_instance_created_idx
  on public.mission_contributions (mission_instance_id, created_at desc);
create index mission_contributions_public_creator_idx
  on public.mission_contributions (world_id, creator_public_tag, created_at desc);

alter table public.idempotent_operations
  drop constraint idempotent_operations_operation_kind_check;
alter table public.idempotent_operations
  add constraint idempotent_operations_operation_kind_check check (
    operation_kind in (
      'world-commit', 'manual-start', 'manual-complete',
      'dismantle-finish', 'mission-contribute'
    )
  );

alter table public.mission_templates enable row level security;
alter table public.mission_template_slots enable row level security;
alter table public.mission_instances enable row level security;
alter table public.mission_contributions enable row level security;

revoke all on table public.mission_templates from anon, authenticated;
revoke all on table public.mission_template_slots from anon, authenticated;
revoke all on table public.mission_instances from anon, authenticated;
revoke all on table public.mission_contributions from anon, authenticated;

comment on table public.mission_template_slots is
  'Exactly 24 authoritative canonical slots per mission template. Symmetry copies are never persisted.';
comment on table public.mission_contributions is
  'One immutable canonical-slot contribution with public identity snapshots; contributor_id remains internal.';

-- Stage 4 keeps one canonical gate in the +Z sector. Clients rotate each
-- canonical block through four quarter turns and deduplicate equal positions.
insert into public.mission_templates (
  id, template_key, version, name, slot_count, palette, layer_height
) values (
  '60000000-0000-4000-8000-000000000001',
  'starlight-gate',
  1,
  '루멘문',
  24,
  array[1, 4, 6, 9, 11]::smallint[],
  7
);

update public.mission_templates
   set next_template_id = id
 where id = '60000000-0000-4000-8000-000000000001';

insert into public.mission_template_slots (
  template_id, slot_index, local_x, local_y, local_z, kind, rotation
) values
  ('60000000-0000-4000-8000-000000000001',  0, -3, 0, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001',  1, -2, 0, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001',  2, -1, 0, 5, 'light', 0),
  ('60000000-0000-4000-8000-000000000001',  3,  0, 0, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001',  4,  1, 0, 5, 'light', 0),
  ('60000000-0000-4000-8000-000000000001',  5,  2, 0, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001',  6,  3, 0, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001',  7, -3, 1, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001',  8, -3, 2, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001',  9, -3, 3, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001', 10, -3, 4, 5, 'stair', 1),
  ('60000000-0000-4000-8000-000000000001', 11, -3, 5, 5, 'stair', 1),
  ('60000000-0000-4000-8000-000000000001', 12,  3, 1, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001', 13,  3, 2, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001', 14,  3, 3, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001', 15,  3, 4, 5, 'stair', 3),
  ('60000000-0000-4000-8000-000000000001', 16,  3, 5, 5, 'stair', 3),
  ('60000000-0000-4000-8000-000000000001', 17, -2, 5, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001', 18, -1, 5, 5, 'light', 0),
  ('60000000-0000-4000-8000-000000000001', 19,  0, 5, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001', 20,  1, 5, 5, 'light', 0),
  ('60000000-0000-4000-8000-000000000001', 21,  2, 5, 5, 'cube',  0),
  ('60000000-0000-4000-8000-000000000001', 22, -2, 4, 5, 'light', 0),
  ('60000000-0000-4000-8000-000000000001', 23,  2, 4, 5, 'light', 0);

create or replace function private.mission_stage_percent(
  p_filled integer,
  p_total integer
)
returns smallint
language sql
immutable
strict
security invoker
set search_path = pg_catalog
as $$
  select case
    when p_filled >= p_total then 100
    when p_filled * 4 >= p_total * 3 then 75
    when p_filled * 2 >= p_total then 50
    when p_filled * 4 >= p_total then 25
    else 0
  end::smallint;
$$;

create or replace function private.mission_palette(
  p_template public.mission_templates,
  p_seed integer
)
returns smallint[]
language plpgsql
immutable
strict
security invoker
set search_path = pg_catalog
as $$
declare
  v_result smallint[] := '{}'::smallint[];
  v_offset integer := ((p_seed % 5) + 5) % 5;
begin
  for v_index in 0..4 loop
    v_result := array_append(v_result, p_template.palette[((v_index + v_offset) % 5) + 1]);
  end loop;
  return v_result;
end;
$$;

create or replace function private.mission_recommended_slots(
  p_instance_id uuid
)
returns smallint[]
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(candidate.slot_index order by candidate.slot_index), '{}'::smallint[])
    from (
      select slot.slot_index
        from public.mission_instances as instance
        join public.mission_template_slots as slot
          on slot.template_id = instance.template_id
       where instance.id = p_instance_id
         and instance.status = 'active'
         and not exists (
           select 1
             from public.mission_contributions as contribution
            where contribution.mission_instance_id = instance.id
              and contribution.slot_index = slot.slot_index
         )
       order by slot.slot_index
       limit 3
    ) as candidate;
$$;

create or replace function private.mission_contribution_public_json(
  p_contribution public.mission_contributions
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'id', p_contribution.id,
    'block_id', p_contribution.block_id,
    'slot_index', p_contribution.slot_index,
    'x', block.x,
    'y', block.y,
    'z', block.z,
    'kind', block.kind,
    'rotation', block.rotation,
    'palette_index', p_contribution.palette_index,
    'color_index', p_contribution.color_index,
    'creator_public_tag', p_contribution.creator_public_tag,
    'nickname_snapshot', p_contribution.nickname_snapshot,
    'creator_emblem', p_contribution.creator_emblem,
    'created_at', p_contribution.created_at,
    'mission_id', instance.id,
    'mission_name', template.name,
    'mission_layer', instance.layer
  )
    from public.blocks as block
    join public.mission_instances as instance
      on instance.id = p_contribution.mission_instance_id
    join public.mission_templates as template
      on template.id = instance.template_id
   where block.id = p_contribution.block_id;
$$;

create or replace function private.mission_instance_public_json(
  p_instance public.mission_instances,
  p_actor uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, private
as $$
declare
  v_template public.mission_templates%rowtype;
  v_blocks jsonb;
  v_contributors jsonb;
  v_recent jsonb;
  v_my_count integer;
  v_participant_count integer;
begin
  select template.* into strict v_template
    from public.mission_templates as template
   where template.id = p_instance.template_id;

  select coalesce(
    jsonb_agg(private.mission_contribution_public_json(contribution)
      order by contribution.slot_index),
    '[]'::jsonb
  ) into v_blocks
    from public.mission_contributions as contribution
   where contribution.mission_instance_id = p_instance.id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'creator_public_tag', grouped.creator_public_tag,
      'nickname_snapshot', grouped.nickname_snapshot,
      'creator_emblem', grouped.creator_emblem,
      'contribution_count', grouped.contribution_count,
      'first_contributed_at', grouped.first_contributed_at,
      'last_contributed_at', grouped.last_contributed_at
    ) order by grouped.first_contributed_at, grouped.creator_public_tag), '[]'::jsonb)
    into v_contributors
    from (
      select distinct on (summary.creator_public_tag)
        summary.creator_public_tag,
        latest.nickname_snapshot,
        latest.creator_emblem,
        summary.contribution_count,
        summary.first_contributed_at,
        summary.last_contributed_at
      from (
        select contribution.creator_public_tag,
               count(*)::integer as contribution_count,
               min(contribution.created_at) as first_contributed_at,
               max(contribution.created_at) as last_contributed_at
          from public.mission_contributions as contribution
         where contribution.mission_instance_id = p_instance.id
         group by contribution.creator_public_tag
      ) as summary
      cross join lateral (
        select contribution.nickname_snapshot, contribution.creator_emblem
          from public.mission_contributions as contribution
         where contribution.mission_instance_id = p_instance.id
           and contribution.creator_public_tag = summary.creator_public_tag
         order by contribution.created_at desc, contribution.id desc
         limit 1
      ) as latest
      order by summary.creator_public_tag
    ) as grouped;

  select coalesce(jsonb_agg(recent.value order by recent.created_at desc), '[]'::jsonb)
    into v_recent
    from (
      select private.mission_contribution_public_json(contribution) as value,
             contribution.created_at
        from public.mission_contributions as contribution
       where contribution.mission_instance_id = p_instance.id
       order by contribution.created_at desc, contribution.id desc
       limit 8
    ) as recent;

  select count(*)::integer into v_my_count
    from public.mission_contributions as contribution
   where contribution.mission_instance_id = p_instance.id
     and contribution.contributor_id = p_actor;

  select count(distinct contribution.creator_public_tag)::integer into v_participant_count
    from public.mission_contributions as contribution
   where contribution.mission_instance_id = p_instance.id;

  return jsonb_build_object(
    'id', p_instance.id,
    'template_key', v_template.template_key,
    'name', v_template.name,
    'layer', p_instance.layer,
    'origin_x', p_instance.origin_x,
    'origin_y', p_instance.origin_y,
    'origin_z', p_instance.origin_z,
    'rotation', p_instance.rotation,
    'palette_seed', p_instance.palette_seed,
    'palette', to_jsonb(private.mission_palette(v_template, p_instance.palette_seed)),
    'status', p_instance.status,
    'filled_slots', p_instance.filled_slots,
    'total_slots', p_instance.total_slots,
    'stage_percent', p_instance.stage_percent,
    'started_at', p_instance.started_at,
    'completed_at', p_instance.completed_at,
    'canonical_blocks', v_blocks,
    'contributors', v_contributors,
    'recent_contributions', v_recent,
    'my_contribution_count', v_my_count,
    'participant_count', v_participant_count,
    'recommended_slot_indexes', to_jsonb(private.mission_recommended_slots(p_instance.id))
  );
end;
$$;

-- Enrich nearby world reads without exposing the internal contributor UUID.
create or replace function private.block_public_json(p_block public.blocks)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
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
    'created_at', p_block.created_at,
    'mission', (
      select jsonb_build_object(
        'id', instance.id,
        'name', template.name,
        'layer', instance.layer,
        'slot_index', contribution.slot_index
      )
        from public.mission_contributions as contribution
        join public.mission_instances as instance
          on instance.id = contribution.mission_instance_id
        join public.mission_templates as template on template.id = instance.template_id
       where contribution.block_id = p_block.id
    )
  );
$$;

create or replace function public.get_mission_overview(p_world_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  v_actor uuid := private.require_actor();
  v_instance public.mission_instances%rowtype;
  v_state public.player_world_state%rowtype;
  v_base_built integer;
  v_producer_built integer;
begin
  select state.* into v_state
    from public.player_world_state as state
   where state.world_id = p_world_id and state.player_id = v_actor;
  if not found then
    raise exception 'player is not bootstrapped in this world' using errcode = '42501';
  end if;

  v_base_built := private.count_filled_guides(
    p_world_id, v_actor, v_state.starter_slot, 'base'
  );
  v_producer_built := private.count_filled_guides(
    p_world_id, v_actor, v_state.starter_slot, 'producer'
  );

  select instance.* into v_instance
    from public.mission_instances as instance
   where instance.world_id = p_world_id and instance.status = 'active';
  if not found then
    raise exception 'world has no active mission' using errcode = '55000';
  end if;

  return jsonb_build_object(
    'active_mission', private.mission_instance_public_json(v_instance, v_actor),
    'eligibility', jsonb_build_object(
      'base_built', v_base_built,
      'producer_built', v_producer_built,
      'eligible', v_base_built >= 16 and v_producer_built >= 8
    ),
    'server_now', clock_timestamp()
  );
end;
$$;

create or replace function public.list_completed_missions(p_world_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  v_actor uuid := private.require_actor();
  v_missions jsonb;
begin
  if not exists (
    select 1 from public.player_world_state as state
     where state.world_id = p_world_id and state.player_id = v_actor
  ) then
    raise exception 'player is not bootstrapped in this world' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(
    private.mission_instance_public_json(instance, v_actor)
    order by instance.completed_at desc, instance.layer desc
  ), '[]'::jsonb)
    into v_missions
    from (
      select completed.*
        from public.mission_instances as completed
       where completed.world_id = p_world_id and completed.status = 'completed'
       order by completed.completed_at desc, completed.layer desc
       limit 50
    ) as instance;

  return jsonb_build_object('missions', v_missions, 'server_now', clock_timestamp());
end;
$$;

create or replace function public.contribute_to_mission(
  p_world_id uuid,
  p_mission_instance_id uuid,
  p_slot_index smallint,
  p_palette_index smallint,
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
  v_hash bytea;
  v_existing public.idempotent_operations%rowtype;
  v_state public.player_world_state%rowtype;
  v_profile public.profiles%rowtype;
  v_instance public.mission_instances%rowtype;
  v_template public.mission_templates%rowtype;
  v_slot public.mission_template_slots%rowtype;
  v_palette smallint[];
  v_actual_color smallint;
  v_x integer;
  v_y integer;
  v_z integer;
  v_rotation smallint;
  v_block public.blocks%rowtype;
  v_contribution public.mission_contributions%rowtype;
  v_filled integer;
  v_stage smallint;
  v_next_template public.mission_templates%rowtype;
  v_next public.mission_instances%rowtype;
  v_response jsonb;
begin
  if p_idempotency_key is null or p_mission_instance_id is null then
    raise exception 'mission, action id, slot, and color are required' using errcode = '22023';
  end if;
  if p_slot_index not between 0 and 23 or p_palette_index not between 0 and 4 then
    raise exception 'mission slot or palette index is outside bounds' using errcode = '22023';
  end if;

  v_hash := private.request_hash(jsonb_build_object(
    'world_id', p_world_id,
    'mission_instance_id', p_mission_instance_id,
    'slot_index', p_slot_index,
    'palette_index', p_palette_index
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'mission-contribute:' || p_world_id::text || ':' || v_actor::text || ':' || p_idempotency_key::text,
    0
  ));

  select operation.* into v_existing
    from public.idempotent_operations as operation
   where operation.world_id = p_world_id
     and operation.player_id = v_actor
     and operation.operation_key = p_idempotency_key;
  if found then
    if v_existing.operation_kind <> 'mission-contribute'
      or v_existing.request_hash <> v_hash then
      raise exception 'idempotency key was used with a different request' using errcode = '22023';
    end if;
    if v_existing.response is null then
      raise exception 'idempotent operation has no completed response' using errcode = '55000';
    end if;
    return v_existing.response || jsonb_build_object('replayed', true);
  end if;

  -- The instance row is the mission-wide serialization point. It makes slot
  -- races and the completed->next-active transition deterministic.
  select instance.* into v_instance
    from public.mission_instances as instance
   where instance.id = p_mission_instance_id
     and instance.world_id = p_world_id
   for update;
  if not found or v_instance.status <> 'active' then
    raise exception 'mission is not the active mission' using errcode = '22023';
  end if;

  select state.* into v_state
    from public.player_world_state as state
   where state.world_id = p_world_id and state.player_id = v_actor
   for update;
  if not found then
    raise exception 'player is not bootstrapped in this world' using errcode = '42501';
  end if;
  select profile.* into strict v_profile
    from public.profiles as profile where profile.user_id = v_actor;

  if private.count_filled_guides(p_world_id, v_actor, v_state.starter_slot, 'base') < 16
    or private.count_filled_guides(p_world_id, v_actor, v_state.starter_slot, 'producer') < 8 then
    raise exception 'base and producer must both be currently complete' using errcode = '42501';
  end if;

  perform private.settle_locked_production(p_world_id, v_actor, v_now);
  select state.* into strict v_state
    from public.player_world_state as state
   where state.world_id = p_world_id and state.player_id = v_actor;
  if v_state.inventory <= 0 then
    raise exception 'insufficient inventory' using errcode = '22023';
  end if;

  if not p_slot_index = any(private.mission_recommended_slots(v_instance.id)) then
    if exists (
      select 1 from public.mission_contributions as contribution
       where contribution.mission_instance_id = v_instance.id
         and contribution.slot_index = p_slot_index
    ) then
      raise exception 'mission slot is already filled' using errcode = '23505';
    end if;
    raise exception 'mission slot is not currently recommended' using errcode = '22023';
  end if;

  select slot.* into v_slot
    from public.mission_template_slots as slot
   where slot.template_id = v_instance.template_id and slot.slot_index = p_slot_index;
  if not found then
    raise exception 'mission template slot does not exist' using errcode = '22023';
  end if;
  if (select count(*) from public.mission_template_slots where template_id = v_instance.template_id) <> 24 then
    raise exception 'mission template must contain exactly 24 canonical slots' using errcode = '55000';
  end if;

  select template.* into strict v_template
    from public.mission_templates as template where template.id = v_instance.template_id;
  v_palette := private.mission_palette(v_template, v_instance.palette_seed);
  v_actual_color := v_palette[p_palette_index + 1];

  if v_instance.rotation = 0 then
    v_x := v_instance.origin_x + v_slot.local_x;
    v_z := v_instance.origin_z + v_slot.local_z;
  elsif v_instance.rotation = 1 then
    v_x := v_instance.origin_x - v_slot.local_z;
    v_z := v_instance.origin_z + v_slot.local_x;
  elsif v_instance.rotation = 2 then
    v_x := v_instance.origin_x - v_slot.local_x;
    v_z := v_instance.origin_z - v_slot.local_z;
  else
    v_x := v_instance.origin_x + v_slot.local_z;
    v_z := v_instance.origin_z - v_slot.local_x;
  end if;
  v_y := v_instance.origin_y + v_slot.local_y;
  v_rotation := ((v_slot.rotation + v_instance.rotation) % 4)::smallint;

  update public.player_world_state
     set inventory = inventory - 1, updated_at = v_now
   where world_id = p_world_id and player_id = v_actor
   returning * into v_state;

  begin
    insert into public.blocks (
      id, world_id, x, y, z, kind, rotation, color_index,
      creator_id, creator_public_tag, nickname_snapshot, creator_emblem,
      zone, zone_slot, support_id, source, created_at
    ) values (
      extensions.gen_random_uuid(), p_world_id, v_x, v_y, v_z,
      v_slot.kind, v_rotation, v_actual_color,
      v_actor, v_profile.public_tag, v_profile.nickname, v_profile.emblem,
      'mission', null, null, 'inventory', v_now
    ) returning * into v_block;

    insert into public.mission_contributions (
      world_id, mission_instance_id, template_id, slot_index, block_id,
      contributor_id, creator_public_tag, nickname_snapshot, creator_emblem,
      palette_index, color_index, created_at
    ) values (
      p_world_id, v_instance.id, v_instance.template_id, p_slot_index, v_block.id,
      v_actor, v_profile.public_tag, v_profile.nickname, v_profile.emblem,
      p_palette_index, v_actual_color, v_now
    ) returning * into v_contribution;
  exception when unique_violation then
    raise exception 'mission slot or coordinate is already filled' using errcode = '23505';
  end;

  select count(*)::integer into v_filled
    from public.mission_contributions as contribution
   where contribution.mission_instance_id = v_instance.id;
  v_stage := private.mission_stage_percent(v_filled, v_instance.total_slots);

  if v_filled = v_instance.total_slots then
    update public.mission_instances
       set filled_slots = v_filled,
           stage_percent = 100,
           status = 'completed',
           completed_at = v_now
     where id = v_instance.id
     returning * into v_instance;

    select template.* into strict v_next_template
      from public.mission_templates as template
     where template.id = coalesce(v_template.next_template_id, v_template.id);

    insert into public.mission_instances (
      world_id, template_id, layer, origin_x, origin_y, origin_z,
      rotation, palette_seed, status, filled_slots, total_slots,
      stage_percent, started_at, created_at
    ) values (
      p_world_id,
      v_next_template.id,
      v_instance.layer + 1,
      v_instance.origin_x,
      v_instance.origin_y + v_template.layer_height,
      v_instance.origin_z,
      ((v_instance.rotation + 1) % 4)::smallint,
      v_instance.palette_seed + 1,
      'active', 0, v_next_template.slot_count, 0, v_now, v_now
    ) returning * into v_next;
  else
    update public.mission_instances
       set filled_slots = v_filled, stage_percent = v_stage
     where id = v_instance.id
     returning * into v_instance;
  end if;

  v_response := jsonb_build_object(
    'mission', private.mission_instance_public_json(v_instance, v_actor),
    'contribution', private.mission_contribution_public_json(v_contribution),
    'progress', private.state_json(v_state),
    'next_mission', case
      when v_next.id is null then null
      else private.mission_instance_public_json(v_next, v_actor)
    end,
    'server_now', v_now,
    'replayed', false
  );

  insert into public.idempotent_operations (
    world_id, player_id, operation_key, operation_kind, request_hash,
    status, response, created_at, completed_at
  ) values (
    p_world_id, v_actor, p_idempotency_key, 'mission-contribute', v_hash,
    'completed', v_response, v_now, v_now
  );
  return v_response;
end;
$$;

revoke execute on function public.get_mission_overview(uuid) from public, anon;
revoke execute on function public.list_completed_missions(uuid) from public, anon;
revoke execute on function public.contribute_to_mission(uuid, uuid, smallint, smallint, uuid) from public, anon;

grant execute on function public.get_mission_overview(uuid) to authenticated;
grant execute on function public.list_completed_missions(uuid) to authenticated;
grant execute on function public.contribute_to_mission(uuid, uuid, smallint, smallint, uuid) to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;

comment on function public.contribute_to_mission(uuid, uuid, smallint, smallint, uuid) is
  'Atomic and idempotent canonical-slot contribution. Symmetry copies are client-derived and never stored.';

-- Existing installations already have worlds when this migration is applied.
insert into public.mission_instances (
  world_id, template_id, layer, origin_x, origin_y, origin_z,
  rotation, palette_seed, status, filled_slots, total_slots, stage_percent
)
select world.id,
       '60000000-0000-4000-8000-000000000001'::uuid,
       1, 0, 1, 0, 0, 0, 'active', 0, 24, 0
  from public.worlds as world
 where not exists (
   select 1 from public.mission_instances as instance
    where instance.world_id = world.id and instance.status = 'active'
 );

commit;

