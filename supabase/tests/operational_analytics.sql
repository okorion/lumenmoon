begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, private, extensions, pg_catalog;

select plan(30);

select ok(to_regclass('public.analytics_events') is null,
  'no public raw analytics event table exists');
select ok(to_regclass('private.analytics_events') is null,
  'no private raw analytics event table exists');
select ok(to_regclass('private.operator_world_metrics') is not null,
  'operator world aggregate view exists');
select ok(to_regclass('private.operator_mission_metrics') is not null,
  'operator mission aggregate view exists');

select ok(not has_table_privilege(
  'authenticated', 'private.operator_world_metrics'::regclass, 'SELECT'
), 'authenticated cannot select world analytics');
select ok(not has_table_privilege(
  'anon', 'private.operator_world_metrics'::regclass, 'SELECT'
), 'anon cannot select world analytics');
select ok(not has_table_privilege(
  'authenticated', 'private.operator_mission_metrics'::regclass, 'SELECT'
), 'authenticated cannot select mission analytics');
select ok(not has_table_privilege(
  'anon', 'private.operator_mission_metrics'::regclass, 'SELECT'
), 'anon cannot select mission analytics');
select ok(has_table_privilege(
  'service_role', 'private.operator_world_metrics'::regclass, 'SELECT'
), 'service role can select world analytics');
select ok(has_table_privilege(
  'service_role', 'private.operator_mission_metrics'::regclass, 'SELECT'
), 'service role can select mission analytics');
select ok(
  not has_table_privilege('service_role', 'private.operator_world_metrics'::regclass, 'INSERT')
  and not has_table_privilege('service_role', 'private.operator_world_metrics'::regclass, 'UPDATE')
  and not has_table_privilege('service_role', 'private.operator_world_metrics'::regclass, 'DELETE'),
  'service role operator world surface is read only'
);
select ok(
  not has_table_privilege('authenticated', 'private.operator_world_metrics'::regclass, 'INSERT')
  and not has_table_privilege('authenticated', 'private.operator_world_metrics'::regclass, 'UPDATE')
  and not has_table_privilege('authenticated', 'private.operator_world_metrics'::regclass, 'DELETE'),
  'authenticated cannot write the operator aggregate'
);
select ok(has_schema_privilege('service_role', 'private', 'USAGE'),
  'service role can resolve private operator views');
select ok(not has_schema_privilege('authenticated', 'private', 'USAGE'),
  'authenticated cannot resolve the private schema');

select ok(
  (select coalesce(reloptions, '{}') @> array['security_invoker=true']
     from pg_class where oid = 'private.operator_world_metrics'::regclass),
  'world aggregate view uses invoker security'
);
select ok(
  (select coalesce(reloptions, '{}') @> array['security_invoker=true']
     from pg_class where oid = 'private.operator_mission_metrics'::regclass),
  'mission aggregate view uses invoker security'
);
select ok(not exists (
  select 1 from pg_attribute
   where attrelid = 'private.operator_world_metrics'::regclass
     and not attisdropped and attname in ('player_id', 'user_id')
), 'world aggregate emits no auth UID column');
select ok(not exists (
  select 1 from pg_attribute
   where attrelid = 'private.operator_world_metrics'::regclass
     and not attisdropped and attname in ('public_tag', 'nickname', 'creator_public_tag')
), 'world aggregate emits no public identity column');

select ok(
  pg_get_functiondef('public.bootstrap_player(uuid)'::regprocedure)
    like '%interval ''30 minutes''%',
  'bootstrap coalesces repeated calls into a 30 minute visit window'
);
select ok(
  pg_get_functiondef(
    'private.settle_locked_production(uuid,uuid,timestamp with time zone)'::regprocedure
  ) like '%total_automatic_produced = total_automatic_produced + v_produced%',
  'DB-clock settlement counts only actually produced automatic blocks'
);
select ok(exists (
  select 1 from pg_trigger
   where tgrelid = 'public.blocks'::regclass
     and tgname = 'count_authoritative_block_change'
     and not tgisinternal
), 'block transaction counter trigger exists');
select ok(exists (
  select 1 from pg_trigger
   where tgrelid = 'public.idempotent_operations'::regclass
     and tgname = 'count_completed_manual_production'
     and not tgisinternal
), 'manual production counter trigger exists');

-- Operator metrics intentionally aggregate the whole world. Isolate the
-- fixture inside this transaction so prior browser/E2E sessions cannot change
-- exact counter assertions; ROLLBACK restores every pre-test row.
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

insert into auth.users (
  instance_id, id, aud, role, is_anonymous, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '45000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', true, clock_timestamp(), clock_timestamp()
);

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '45000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;

do $$ begin
  perform public.bootstrap_player('00000000-0000-4000-8000-000000000001');
end $$;
select is((
  select join_count from public.player_world_state
   where player_id = '45000000-0000-4000-8000-000000000001'
), 1::bigint, 'first bootstrap records one coarse visit');

do $$ begin
  perform public.bootstrap_player('00000000-0000-4000-8000-000000000001');
end $$;
select is((
  select join_count from public.player_world_state
   where player_id = '45000000-0000-4000-8000-000000000001'
), 1::bigint, 'same-session bootstrap does not duplicate a visit');

update public.player_world_state
   set last_joined_at = clock_timestamp() - interval '31 minutes'
 where player_id = '45000000-0000-4000-8000-000000000001';
do $$ begin
  perform public.bootstrap_player('00000000-0000-4000-8000-000000000001');
end $$;
select is((
  select join_count from public.player_world_state
   where player_id = '45000000-0000-4000-8000-000000000001'
), 2::bigint, 'bootstrap after 31 minutes records a return visit');

insert into public.blocks (
  id, world_id, x, y, z, kind, rotation, color_index,
  creator_id, creator_public_tag, nickname_snapshot, creator_emblem,
  zone, zone_slot, support_id, source
)
select '45000000-0000-4000-8000-000000000002',
       '00000000-0000-4000-8000-000000000001',
       200, 1, 200, 'cube', 0, 0,
       profile.user_id, profile.public_tag, profile.nickname, profile.emblem,
       'public', null, null, 'inventory'
  from public.profiles as profile
 where profile.user_id = '45000000-0000-4000-8000-000000000001';
select is((
  select total_blocks_placed from public.player_world_state
   where player_id = '45000000-0000-4000-8000-000000000001'
), 1::bigint, 'authoritative block insert increments placement once');

delete from public.blocks where id = '45000000-0000-4000-8000-000000000002';
select is((
  select total_own_blocks_removed from public.player_world_state
   where player_id = '45000000-0000-4000-8000-000000000001'
), 1::bigint, 'authoritative own block delete increments removal once');

insert into public.idempotent_operations (
  world_id, player_id, operation_key, operation_kind, request_hash,
  status, response, created_at, completed_at
) values (
  '00000000-0000-4000-8000-000000000001',
  '45000000-0000-4000-8000-000000000001',
  '45000000-0000-4000-8000-000000000003',
  'manual-complete', decode('01', 'hex'), 'completed', '{}'::jsonb,
  clock_timestamp(), clock_timestamp()
);
select is((
  select total_manual_produced from public.player_world_state
   where player_id = '45000000-0000-4000-8000-000000000001'
), 1::bigint, 'completed manual-production operation increments once');

select is((
  select total_blocks_placed from private.operator_world_metrics
   where world_id = '00000000-0000-4000-8000-000000000001'
), 1::bigint, 'world aggregate reports the exact placement counter');
select is((
  select player_count from private.operator_world_metrics
   where world_id = '00000000-0000-4000-8000-000000000001'
), 1::bigint, 'world aggregate counts each player once');

select * from finish();
rollback;
