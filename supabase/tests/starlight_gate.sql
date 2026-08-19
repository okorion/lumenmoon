begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, private, extensions, pg_catalog;

select plan(57);

select ok(to_regclass('public.mission_templates') is not null, 'mission templates table exists');
select ok(to_regclass('public.mission_template_slots') is not null, 'mission template slots table exists');
select ok(to_regclass('public.mission_instances') is not null, 'mission instances table exists');
select ok(to_regclass('public.mission_contributions') is not null, 'mission contributions table exists');
select ok(
  (select bool_and(class.relrowsecurity)
     from pg_class as class
     join pg_namespace as namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relname in (
        'mission_templates', 'mission_template_slots',
        'mission_instances', 'mission_contributions'
      )),
  'all mission tables have RLS enabled'
);
select ok(
  not has_table_privilege('authenticated', 'public.mission_contributions', 'INSERT'),
  'mission contribution direct writes are denied'
);
select ok(
  not has_table_privilege('authenticated', 'public.mission_instances', 'UPDATE'),
  'mission instance direct writes are denied'
);
select ok(
  to_regprocedure('public.get_mission_overview(uuid)') is not null,
  'mission overview RPC exists'
);
select ok(
  to_regprocedure('public.contribute_to_mission(uuid,uuid,smallint,smallint,uuid)') is not null,
  'mission contribution RPC exists'
);
select ok(
  to_regprocedure('public.list_completed_missions(uuid)') is not null,
  'mission archive RPC exists'
);
select ok(
  position(
    'limit 50' in lower(
      pg_get_functiondef('public.list_completed_missions(uuid)'::regprocedure)
    )
  ) > 0,
  'mission archive RPC caps the completed mission response'
);
select is(
  (select count(*)::integer
     from public.mission_template_slots
    where template_id = '60000000-0000-4000-8000-000000000001'),
  24,
  'starlight gate has exactly 24 canonical server slots'
);
select is(
  (select name
     from public.mission_templates
    where id = '60000000-0000-4000-8000-000000000001'),
  '별빛 관문',
  'existing starlight gate templates use the current product name'
);
select throws_ok(
  $$insert into public.mission_templates (
      id, template_key, version, name, slot_count, palette, layer_height
    ) values (
      '60000000-0000-4000-8000-000000000099',
      'invalid-duplicate-palette', 1, 'invalid', 24,
      array[1, 1, 4, 6, 9]::smallint[], 7
    )$$,
  '23514',
  'new row for relation "mission_templates" violates check constraint "mission_templates_five_color_palette"',
  'mission templates reject duplicate colors in their five-color palette'
);
select is(
  (select count(*)::integer
     from public.mission_instances
    where world_id = '00000000-0000-4000-8000-000000000001'
      and status = 'active'),
  1,
  'seed creates exactly one active mission'
);

-- Preserve the seed assertion above, then establish an empty layer-1 fixture
-- inside this transaction. Browser/E2E runs may have completed layers and
-- occupied starter slots; ROLLBACK restores that persistent world afterward.
delete from public.dismantle_tickets
 where world_id = '00000000-0000-4000-8000-000000000001';
delete from public.idempotent_operations
 where world_id = '00000000-0000-4000-8000-000000000001';
delete from public.mission_contributions
 where world_id = '00000000-0000-4000-8000-000000000001';
delete from public.blocks
 where world_id = '00000000-0000-4000-8000-000000000001';
delete from public.player_world_state
 where world_id = '00000000-0000-4000-8000-000000000001';
delete from public.mission_instances
 where world_id = '00000000-0000-4000-8000-000000000001';
insert into public.mission_instances (
  world_id, template_id, layer, origin_x, origin_y, origin_z,
  rotation, palette_seed, status, filled_slots, total_slots, stage_percent
) values (
  '00000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000001',
  1, 0, 1, 0, 0, 0, 'active', 0, 24, 0
);

insert into auth.users (
  instance_id, id, aud, role, is_anonymous, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '11000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', true, clock_timestamp(), clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '11000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', true, clock_timestamp(), clock_timestamp()
  );

create temporary table stage4_values (
  name text primary key,
  value_text text,
  value_uuid uuid,
  payload jsonb
) on commit drop;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '11000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', true
  )::text,
  true
);
select public.bootstrap_player('00000000-0000-4000-8000-000000000001');

insert into stage4_values (name, value_text)
select 'actor-a-original-nickname', profile.nickname
  from public.profiles as profile
 where profile.user_id = '11000000-0000-4000-8000-000000000001';
insert into stage4_values (name, value_text)
select 'actor-a-public-tag', profile.public_tag
  from public.profiles as profile
 where profile.user_id = '11000000-0000-4000-8000-000000000001';
insert into stage4_values (name, value_uuid)
select 'mission-1', instance.id
  from public.mission_instances as instance
 where instance.world_id = '00000000-0000-4000-8000-000000000001'
   and instance.status = 'active';

-- Actor A completes onboarding through the same authoritative 24-action RPC.
insert into stage4_values (name, payload)
select
  'actor-a-onboarding',
  jsonb_agg(
    jsonb_build_object(
      'type', 'place',
      'block_id', extensions.gen_random_uuid(),
      'x', coordinate.x,
      'y', coordinate.y,
      'z', coordinate.z,
      'kind', guide.expected_kind,
      'rotation', guide.expected_rotation,
      'color_index', 0,
      'support_id', null
    ) order by guide.guide_group, coordinate.y, coordinate.z, coordinate.x
  )
from generate_series(-2, 5) as grid_x(x)
cross join generate_series(1, 3) as grid_y(y)
cross join generate_series(-28, -25) as grid_z(z)
cross join lateral (
  select grid_x.x, grid_y.y, grid_z.z
) as coordinate
cross join lateral private.guide_at(0, coordinate.x, coordinate.y, coordinate.z) as guide
where guide.guide_group in ('base', 'producer');

select public.commit_world_actions(
  '00000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000001',
  (select payload from stage4_values where name = 'actor-a-onboarding')
);

-- Actor B is bootstrapped but not complete yet.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '11000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', true
  )::text,
  true
);
select public.bootstrap_player('00000000-0000-4000-8000-000000000001');

select throws_ok(
  format(
    'select public.contribute_to_mission(%L::uuid,%L::uuid,0::smallint,0::smallint,%L::uuid)',
    '00000000-0000-4000-8000-000000000001',
    (select value_uuid from stage4_values where name = 'mission-1'),
    '62000000-0000-4000-8000-000000000001'
  ),
  '42501',
  'base and producer must both be currently complete',
  'an incomplete player cannot contribute'
);
select is(
  (select state.inventory::integer
     from public.player_world_state as state
    where state.world_id = '00000000-0000-4000-8000-000000000001'
      and state.player_id = '11000000-0000-4000-8000-000000000002'),
  24,
  'rejected incomplete contribution does not spend inventory'
);

-- Complete actor B's guides as controlled test setup, so the race and
-- insufficient-inventory paths are reached after the participation gate.
insert into public.blocks (
  id, world_id, x, y, z, kind, rotation, color_index,
  creator_id, creator_public_tag, nickname_snapshot, creator_emblem,
  zone, zone_slot, support_id, source, created_at
)
select extensions.gen_random_uuid(),
       '00000000-0000-4000-8000-000000000001',
       coordinate.x, coordinate.y, coordinate.z,
       guide.expected_kind, guide.expected_rotation, 0,
       profile.user_id, profile.public_tag, profile.nickname, profile.emblem,
       case guide.guide_group
         when 'base' then 'personal'::public.block_zone
         else 'producer'::public.block_zone
       end,
       1, null, 'onboarding', clock_timestamp()
  from generate_series(20, 32) as grid_x(x)
 cross join generate_series(1, 5) as grid_y(y)
 cross join generate_series(-32, -20) as grid_z(z)
 cross join lateral (
   select grid_x.x, grid_y.y, grid_z.z
 ) as coordinate
 cross join lateral private.guide_at(1, coordinate.x, coordinate.y, coordinate.z) as guide
 cross join public.profiles as profile
 where profile.user_id = '11000000-0000-4000-8000-000000000002'
   and guide.guide_group in ('base', 'producer');

update public.player_world_state
   set inventory = 5,
       base_completed = true,
       base_completed_at = clock_timestamp(),
       producer_completed = true,
       producer_completed_at = clock_timestamp(),
       trial_reward_claimed = true,
       last_settled_at = clock_timestamp()
 where world_id = '00000000-0000-4000-8000-000000000001'
   and player_id = '11000000-0000-4000-8000-000000000002';

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '11000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', true
  )::text,
  true
);
update public.player_world_state
   set inventory = 36, last_settled_at = clock_timestamp()
 where world_id = '00000000-0000-4000-8000-000000000001'
   and player_id = '11000000-0000-4000-8000-000000000001';

insert into stage4_values (name, payload)
values (
  'initial-overview',
  public.get_mission_overview('00000000-0000-4000-8000-000000000001')
);
select is(
  (select payload #>> '{active_mission,recommended_slot_indexes}'
     from stage4_values where name = 'initial-overview'),
  '[0, 1, 2]',
  'overview recommends at most the first three currently available slots'
);
select is(
  (select (payload #>> '{active_mission,stage_percent}')::integer
     from stage4_values where name = 'initial-overview'),
  0,
  'empty mission begins at stage zero'
);

insert into stage4_values (name, payload)
values (
  'slot-0-response',
  public.contribute_to_mission(
    '00000000-0000-4000-8000-000000000001',
    (select value_uuid from stage4_values where name = 'mission-1'),
    0::smallint, 2::smallint,
    '63000000-0000-4000-8000-000000000001'
  )
);
select is(
  (select count(*)::integer
     from public.mission_contributions
    where mission_instance_id = (select value_uuid from stage4_values where name = 'mission-1')),
  1,
  'one canonical slot creates exactly one contribution row'
);
select is(
  (select count(*)::integer
     from public.blocks
    where zone = 'mission'
      and world_id = '00000000-0000-4000-8000-000000000001'),
  1,
  'symmetry copies and previews are not stored as block rows'
);
select is(
  (select state.inventory::integer
     from public.player_world_state as state
    where state.world_id = '00000000-0000-4000-8000-000000000001'
      and state.player_id = '11000000-0000-4000-8000-000000000001'),
  35,
  'successful contribution spends exactly one shared inventory block'
);
select ok(
  (select payload::text not like '%11000000-0000-4000-8000-000000000001%'
     from stage4_values where name = 'slot-0-response'),
  'contribution response does not expose the internal auth UID'
);
select ok(
  (select (public.contribute_to_mission(
    '00000000-0000-4000-8000-000000000001',
    (select value_uuid from stage4_values where name = 'mission-1'),
    0::smallint, 2::smallint,
    '63000000-0000-4000-8000-000000000001'
  ) ->> 'replayed')::boolean),
  'same action id and payload replays the stored contribution response'
);
select is(
  (select count(*)::integer
     from public.mission_contributions
    where mission_instance_id = (select value_uuid from stage4_values where name = 'mission-1')),
  1,
  'idempotent replay does not add contribution credit'
);
select is(
  (select state.inventory::integer
     from public.player_world_state as state
    where state.world_id = '00000000-0000-4000-8000-000000000001'
      and state.player_id = '11000000-0000-4000-8000-000000000001'),
  35,
  'idempotent replay does not spend inventory again'
);
select throws_ok(
  format(
    'select public.contribute_to_mission(%L::uuid,%L::uuid,1::smallint,2::smallint,%L::uuid)',
    '00000000-0000-4000-8000-000000000001',
    (select value_uuid from stage4_values where name = 'mission-1'),
    '63000000-0000-4000-8000-000000000001'
  ),
  '22023',
  'idempotency key was used with a different request',
  'same action id with another slot is rejected'
);

-- Changing a nickname does not change the public tag or rewrite slot 0.
update public.profiles
   set nickname = case
     when nickname = '빛나는 고래' then '고요한 여우'
     else '빛나는 고래'
   end
 where user_id = '11000000-0000-4000-8000-000000000001';
select public.contribute_to_mission(
  '00000000-0000-4000-8000-000000000001',
  (select value_uuid from stage4_values where name = 'mission-1'),
  1::smallint, 4::smallint,
  '63000000-0000-4000-8000-000000000002'
);
select isnt(
  (select nickname_snapshot from public.mission_contributions
    where mission_instance_id = (select value_uuid from stage4_values where name = 'mission-1')
      and slot_index = 0),
  (select nickname_snapshot from public.mission_contributions
    where mission_instance_id = (select value_uuid from stage4_values where name = 'mission-1')
      and slot_index = 1),
  'a prior contribution preserves its nickname snapshot after a profile change'
);
select is(
  (select count(distinct creator_public_tag)::integer
     from public.mission_contributions
    where mission_instance_id = (select value_uuid from stage4_values where name = 'mission-1')
      and slot_index in (0, 1)),
  1,
  'past and new contributions remain linked by the fixed public tag'
);

-- Actor B now reaches the same occupied slot after passing participation gates.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '11000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', true
  )::text,
  true
);
select throws_ok(
  format(
    'select public.contribute_to_mission(%L::uuid,%L::uuid,0::smallint,0::smallint,%L::uuid)',
    '00000000-0000-4000-8000-000000000001',
    (select value_uuid from stage4_values where name = 'mission-1'),
    '64000000-0000-4000-8000-000000000001'
  ),
  '23505',
  'mission slot is already filled',
  'the losing same-slot request is rejected'
);
select is(
  (select state.inventory::integer
     from public.player_world_state as state
    where state.world_id = '00000000-0000-4000-8000-000000000001'
      and state.player_id = '11000000-0000-4000-8000-000000000002'),
  5,
  'same-slot loser inventory is unchanged'
);
update public.player_world_state
   set inventory = 0, last_settled_at = clock_timestamp()
 where world_id = '00000000-0000-4000-8000-000000000001'
   and player_id = '11000000-0000-4000-8000-000000000002';
select throws_ok(
  format(
    'select public.contribute_to_mission(%L::uuid,%L::uuid,2::smallint,0::smallint,%L::uuid)',
    '00000000-0000-4000-8000-000000000001',
    (select value_uuid from stage4_values where name = 'mission-1'),
    '64000000-0000-4000-8000-000000000002'
  ),
  '22023',
  'insufficient inventory',
  'zero inventory contribution is rejected'
);
select is(
  (select count(*)::integer from public.mission_contributions
    where mission_instance_id = (select value_uuid from stage4_values where name = 'mission-1')
      and slot_index = 2),
  0,
  'inventory rejection leaves the recommended slot empty'
);
update public.player_world_state
   set inventory = 5, last_settled_at = clock_timestamp()
 where world_id = '00000000-0000-4000-8000-000000000001'
   and player_id = '11000000-0000-4000-8000-000000000002';

-- Actor A fills the remaining canonical slots and crosses every stage.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '11000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', true
  )::text,
  true
);
do $$
declare
  v_mission uuid := (select value_uuid from stage4_values where name = 'mission-1');
  v_slot integer;
begin
  for v_slot in 2..5 loop
    perform public.contribute_to_mission(
      '00000000-0000-4000-8000-000000000001', v_mission,
      v_slot::smallint, (v_slot % 5)::smallint, extensions.gen_random_uuid()
    );
  end loop;
end;
$$;
select is(
  (select stage_percent::integer from public.mission_instances
    where id = (select value_uuid from stage4_values where name = 'mission-1')),
  25,
  'six filled slots switch the mission to the 25 percent stage'
);
do $$
declare
  v_mission uuid := (select value_uuid from stage4_values where name = 'mission-1');
  v_slot integer;
begin
  for v_slot in 6..11 loop
    perform public.contribute_to_mission(
      '00000000-0000-4000-8000-000000000001', v_mission,
      v_slot::smallint, (v_slot % 5)::smallint, extensions.gen_random_uuid()
    );
  end loop;
end;
$$;
select is(
  (select stage_percent::integer from public.mission_instances
    where id = (select value_uuid from stage4_values where name = 'mission-1')),
  50,
  'twelve filled slots switch the mission to the 50 percent stage'
);
do $$
declare
  v_mission uuid := (select value_uuid from stage4_values where name = 'mission-1');
  v_slot integer;
begin
  for v_slot in 12..17 loop
    perform public.contribute_to_mission(
      '00000000-0000-4000-8000-000000000001', v_mission,
      v_slot::smallint, (v_slot % 5)::smallint, extensions.gen_random_uuid()
    );
  end loop;
end;
$$;
select is(
  (select stage_percent::integer from public.mission_instances
    where id = (select value_uuid from stage4_values where name = 'mission-1')),
  75,
  'eighteen filled slots switch the mission to the 75 percent stage'
);
do $$
declare
  v_mission uuid := (select value_uuid from stage4_values where name = 'mission-1');
  v_slot integer;
begin
  for v_slot in 18..22 loop
    perform public.contribute_to_mission(
      '00000000-0000-4000-8000-000000000001', v_mission,
      v_slot::smallint, (v_slot % 5)::smallint, extensions.gen_random_uuid()
    );
  end loop;
end;
$$;
select is(
  (select filled_slots::integer from public.mission_instances
    where id = (select value_uuid from stage4_values where name = 'mission-1')),
  23,
  'twenty-three canonical slots remain an active 75 percent mission'
);

insert into stage4_values (name, payload)
values (
  'completion-response',
  public.contribute_to_mission(
    '00000000-0000-4000-8000-000000000001',
    (select value_uuid from stage4_values where name = 'mission-1'),
    23::smallint, 3::smallint,
    '65000000-0000-4000-8000-000000000001'
  )
);
select is(
  (select status from public.mission_instances
    where id = (select value_uuid from stage4_values where name = 'mission-1')),
  'completed',
  'the 24th canonical slot freezes the mission as completed'
);
select is(
  (select stage_percent::integer from public.mission_instances
    where id = (select value_uuid from stage4_values where name = 'mission-1')),
  100,
  'completion records the 100 percent stage'
);
select ok(
  (select payload -> 'next_mission' is not null
     and jsonb_typeof(payload -> 'next_mission') = 'object'
     from stage4_values where name = 'completion-response'),
  'completion response includes the newly activated next mission'
);
select is(
  (select count(*)::integer from public.mission_instances
    where world_id = '00000000-0000-4000-8000-000000000001'
      and status = 'active'),
  1,
  'completion creates exactly one next active mission'
);
select is(
  (select layer from public.mission_instances
    where world_id = '00000000-0000-4000-8000-000000000001'
      and status = 'active'),
  2,
  'next active mission advances one layer'
);
select is(
  (select count(*)::integer from public.mission_contributions
    where mission_instance_id = (select value_uuid from stage4_values where name = 'mission-1')),
  24,
  'completion retains exactly 24 canonical contribution records'
);
select is(
  (select count(*)::integer from public.blocks
    where world_id = '00000000-0000-4000-8000-000000000001' and zone = 'mission'),
  24,
  'completed monument persists canonical blocks only, not 96 copies'
);

-- A serialized loser targeting the old final slot sees completion and cannot
-- spend inventory or create another next mission.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '11000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', true
  )::text,
  true
);
select throws_ok(
  format(
    'select public.contribute_to_mission(%L::uuid,%L::uuid,23::smallint,1::smallint,%L::uuid)',
    '00000000-0000-4000-8000-000000000001',
    (select value_uuid from stage4_values where name = 'mission-1'),
    '65000000-0000-4000-8000-000000000002'
  ),
  '22023',
  'mission is not the active mission',
  'a competing final-slot request loses after the serialized completion'
);
select is(
  (select state.inventory::integer from public.player_world_state as state
    where state.world_id = '00000000-0000-4000-8000-000000000001'
      and state.player_id = '11000000-0000-4000-8000-000000000002'),
  5,
  'losing final-slot request does not spend inventory'
);
select is(
  (select count(*)::integer from public.mission_instances
    where world_id = '00000000-0000-4000-8000-000000000001'
      and status = 'active'),
  1,
  'losing final-slot request cannot duplicate the next mission'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '11000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', true
  )::text,
  true
);
insert into stage4_values (name, payload)
values (
  'archive',
  public.list_completed_missions('00000000-0000-4000-8000-000000000001')
);
select is(
  (select jsonb_array_length(payload -> 'missions')
     from stage4_values where name = 'archive'),
  1,
  'archive lists the completed mission card'
);
select ok(
  (select payload #> '{missions,0,completed_at}' <> 'null'::jsonb
     from stage4_values where name = 'archive'),
  'archive preserves the authoritative completion time'
);
select is(
  (select (payload #>> '{missions,0,contributors,0,contribution_count}')::integer
     from stage4_values where name = 'archive'),
  24,
  'archive shows contribution count without creating a competitive ranking'
);
select is(
  (select payload #>> '{missions,0,contributors,0,nickname_snapshot}'
     from stage4_values where name = 'archive'),
  (select nickname from public.profiles
    where user_id = '11000000-0000-4000-8000-000000000001'),
  'archive keeps the latest completion-time participant identity snapshot'
);
select ok(
  (select payload::text not like '%11000000-0000-4000-8000-000000000001%'
     from stage4_values where name = 'archive'),
  'archive never exposes contributor auth UIDs'
);

select throws_ok(
  format(
    'select public.commit_world_actions(%L::uuid,%L::uuid,%L::jsonb)',
    '00000000-0000-4000-8000-000000000001',
    '66000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'type', 'remove',
      'block_id', (
        select block_id from public.mission_contributions
         where mission_instance_id = (select value_uuid from stage4_values where name = 'mission-1')
           and slot_index = 0
      )
    ))::text
  ),
  '42501',
  'protected block cannot be removed',
  'completed mission blocks are immutable through world mutation RPCs'
);
select ok(
  not jsonb_path_exists(
    public.get_nearby_blocks(
      '00000000-0000-4000-8000-000000000001', 0, 0, 0, 1, 1
    ),
    '$.blocks[*] ? (@.zone == "mission")'
  ),
  'nearby chunk reads exclude mission rows so overview is the sole mission render source'
);

-- Exercise the former height boundary directly. Promote the empty layer-2
-- instance to layer 7, seed its first 23 canonical rows as controlled fixture
-- data, then finish slot 23 through the public RPC. The transaction must be
-- able to create layer 8 at y=50 without rolling back the final contribution.
update public.mission_instances
   set layer = 7,
       origin_y = 43,
       rotation = 2,
       palette_seed = 6,
       filled_slots = 23,
       stage_percent = 75
 where world_id = '00000000-0000-4000-8000-000000000001'
   and status = 'active';

insert into public.blocks (
  id, world_id, x, y, z, kind, rotation, color_index,
  creator_id, creator_public_tag, nickname_snapshot, creator_emblem,
  zone, zone_slot, support_id, source, created_at
)
select (
         '77000000-0000-4000-8000-' || lpad(slot.slot_index::text, 12, '0')
       )::uuid,
       instance.world_id,
       instance.origin_x - slot.local_x,
       instance.origin_y + slot.local_y,
       instance.origin_z - slot.local_z,
       slot.kind,
       ((slot.rotation + instance.rotation) % 4)::smallint,
       1,
       profile.user_id,
       profile.public_tag,
       profile.nickname,
       profile.emblem,
       'mission', null, null, 'inventory', clock_timestamp()
  from public.mission_instances as instance
  join public.mission_template_slots as slot
    on slot.template_id = instance.template_id and slot.slot_index between 0 and 22
  join public.profiles as profile
    on profile.user_id = '11000000-0000-4000-8000-000000000001'
 where instance.world_id = '00000000-0000-4000-8000-000000000001'
   and instance.status = 'active';

insert into public.mission_contributions (
  world_id, mission_instance_id, template_id, slot_index, block_id,
  contributor_id, creator_public_tag, nickname_snapshot, creator_emblem,
  palette_index, color_index, created_at
)
select instance.world_id,
       instance.id,
       instance.template_id,
       slot.slot_index,
       ('77000000-0000-4000-8000-' || lpad(slot.slot_index::text, 12, '0'))::uuid,
       profile.user_id,
       profile.public_tag,
       profile.nickname,
       profile.emblem,
       0,
       1,
       clock_timestamp()
  from public.mission_instances as instance
  join public.mission_template_slots as slot
    on slot.template_id = instance.template_id and slot.slot_index between 0 and 22
  join public.profiles as profile
    on profile.user_id = '11000000-0000-4000-8000-000000000001'
 where instance.world_id = '00000000-0000-4000-8000-000000000001'
   and instance.status = 'active';

insert into stage4_values (name, value_uuid)
select 'mission-7', instance.id
  from public.mission_instances as instance
 where instance.world_id = '00000000-0000-4000-8000-000000000001'
   and instance.status = 'active';

select lives_ok(
  format(
    'select public.contribute_to_mission(%L::uuid,%L::uuid,23::smallint,0::smallint,%L::uuid)',
    '00000000-0000-4000-8000-000000000001',
    (select value_uuid from stage4_values where name = 'mission-7'),
    '78000000-0000-4000-8000-000000000001'
  ),
  'finishing layer 7 creates layer 8 without a height-bound rollback'
);
select is(
  (select layer from public.mission_instances
    where world_id = '00000000-0000-4000-8000-000000000001'
      and status = 'active'),
  8,
  'layer 8 is the one active mission after the boundary transition'
);
select is(
  (select origin_y from public.mission_instances
    where world_id = '00000000-0000-4000-8000-000000000001'
      and status = 'active'),
  50,
  'layer 8 retains the configured seven-block vertical spacing'
);

select * from finish();
rollback;
