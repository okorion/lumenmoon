begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, private, extensions, pg_catalog;

select plan(112);

select ok(
  to_regclass('public.free_mode_player_state') is not null,
  'free-mode state table exists'
);
select ok(
  to_regclass('public.free_mode_blocks') is not null,
  'free-mode block table exists'
);
select ok(
  to_regclass('public.free_mode_operations') is not null,
  'free-mode idempotency table exists'
);
select ok(
  exists (
    select 1
      from pg_indexes
     where schemaname = 'public'
       and tablename = 'free_mode_operations'
       and indexname = 'free_mode_operations_completed_idx'
  ),
  'expired idempotency responses have an indexed cleanup path'
);
select ok(
  (select bool_and(class.relrowsecurity)
     from pg_class as class
     join pg_namespace as namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relname in (
        'free_mode_player_state', 'free_mode_blocks', 'free_mode_operations'
      )),
  'all free-mode tables have RLS enabled'
);
select ok(
  not has_table_privilege('authenticated', 'public.free_mode_blocks', 'INSERT'),
  'browser cannot insert free-mode blocks directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.free_mode_player_state', 'UPDATE'),
  'browser cannot overwrite free-mode inventory directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.free_mode_operations', 'SELECT'),
  'browser cannot inspect internal idempotency rows'
);
select ok(
  to_regprocedure('public.get_free_mode_overview(uuid)') is not null,
  'free-mode overview RPC exists'
);
select ok(
  to_regprocedure('public.get_player_identity(uuid)') is not null,
  'mode-neutral public identity RPC exists'
);
select ok(
  to_regprocedure('public.settle_free_mode_inventory(uuid)') is not null,
  'free-mode settlement RPC exists'
);
select ok(
  to_regprocedure('public.commit_free_mode_actions(uuid,uuid,jsonb)') is not null,
  'free-mode commit RPC exists'
);
select ok(
  pg_get_functiondef(
    'public.commit_free_mode_actions(uuid,uuid,jsonb)'::regprocedure
  ) like '%free-mode-rate:%',
  'different operation keys from one actor share a rate-limit lock'
);
select ok(
  to_regprocedure(
    'public.get_nearby_free_mode_blocks(uuid,integer,integer,integer,integer,integer)'
  ) is not null,
  'bounded free-mode chunk RPC exists'
);
select ok(
  pg_get_constraintdef(
    (select con.oid
       from pg_constraint as con
      where con.conrelid = 'public.free_mode_player_state'::regclass
        and con.conname = 'free_mode_initial_grant_is_one_time')
  ) like '%initial_grant_claimed%',
  'initial free-mode grant cannot be reopened'
);
select ok(
  exists (
    select 1
      from pg_constraint as con
     where con.conrelid = 'public.free_mode_blocks'::regclass
       and con.contype = 'u'
       and pg_get_constraintdef(con.oid)
         = 'UNIQUE (world_id, x, y, z)'
  ),
  'world coordinates have a database uniqueness guard'
);
select ok(
  pg_get_functiondef(
    'private.free_mode_block_public_json(public.free_mode_blocks)'::regprocedure
  ) not like '%' || quote_literal('creator_id') || '%',
  'public free-mode block JSON omits auth UID'
);
select ok(
  pg_get_functiondef(
    'private.free_mode_block_public_json(public.free_mode_blocks)'::regprocedure
  ) like '%''source'', ''free''%',
  'public free-mode block JSON identifies its isolated source'
);
select ok(
  private.free_mode_position_is_protected(
    '00000000-0000-4000-8000-000000000001', 0, 5, 0
  ),
  'central tower height is protected even without a mutable system row'
);
select ok(
  private.free_mode_position_is_protected(
    '00000000-0000-4000-8000-000000000001', 0, 1, -29
  ),
  'shared free-mode spawn cell is protected at player height'
);
select ok(
  private.free_mode_position_is_protected(
    '00000000-0000-4000-8000-000000000001', 1, 2, -22
  ),
  'shared escape route is protected through player height'
);
select ok(
  private.free_mode_position_is_protected(
    '00000000-0000-4000-8000-000000000001', 1, 2, -8
  ),
  'shared spawn has a protected route to the central plaza edge'
);
select ok(
  private.free_mode_position_is_protected(
    '00000000-0000-4000-8000-000000000001', 7, 2, 7
  ),
  'shared route opens into a protected central pad around world origin'
);
select ok(
  not private.free_mode_position_is_protected(
    '00000000-0000-4000-8000-000000000001', 8, 2, 7
  ),
  'ordinary free building resumes immediately beyond the central pad'
);
select ok(
  not private.free_mode_position_is_protected(
    '00000000-0000-4000-8000-000000000001', 7, 2, -12
  ),
  'the central pad is not shifted toward the shared spawn'
);
select ok(
  not private.free_mode_position_is_protected(
    '00000000-0000-4000-8000-000000000001', 2, 1, -29
  ),
  'the rest of the starter platform remains available for immediate building'
);
select ok(
  not private.free_mode_position_is_protected(
    '00000000-0000-4000-8000-000000000001', 0, 3, -29
  ),
  'shared spawn protection does not reserve the sky above player height'
);
select ok(
  not private.free_mode_position_is_protected(
    '00000000-0000-4000-8000-000000000001', 40, 1, 40
  ),
  'ordinary free-build ground remains available'
);
select ok(
  not private.free_mode_position_is_protected(
    '00000000-0000-4000-8000-000000000001', 0, 9, 0
  ),
  'space above the actual central tower is not reserved forever'
);
select ok(
  pg_get_functiondef(
    'public.commit_free_mode_actions(uuid,uuid,jsonb)'::regprocedure
  ) like '%clock_timestamp()%'
  and pg_get_functiondef(
    'public.commit_free_mode_actions(uuid,uuid,jsonb)'::regprocedure
  ) like '%interval ''72 hours''%',
  'commit uses DB time for the foreign-removal window'
);
select ok(
  pg_get_functiondef(
    'public.commit_free_mode_actions(uuid,uuid,jsonb)'::regprocedure
  ) like '%jsonb_array_length(p_actions)%'
  and pg_get_functiondef(
    'public.commit_free_mode_actions(uuid,uuid,jsonb)'::regprocedure
  ) like '%octet_length(p_actions::text) > 32768%',
  'commit bounds action count and request bytes'
);
select ok(
  not has_function_privilege(
    'anon', 'public.commit_free_mode_actions(uuid,uuid,jsonb)', 'EXECUTE'
  ),
  'anonymous HTTP role cannot call free-mode mutations without a session'
);
select ok(
  has_function_privilege(
    'authenticated', 'public.commit_free_mode_actions(uuid,uuid,jsonb)', 'EXECUTE'
  ),
  'authenticated anonymous sessions can call free-mode mutations'
);
select ok(
  not has_function_privilege(
    'anon', 'public.get_player_identity(uuid)', 'EXECUTE'
  ) and has_function_privilege(
    'authenticated', 'public.get_player_identity(uuid)', 'EXECUTE'
  ),
  'only authenticated sessions can prepare a public identity'
);
select ok(
  pg_get_functiondef(
    'public.commit_free_mode_actions(uuid,uuid,jsonb)'::regprocedure
  ) like '%free-mode-chunk:%'
  and pg_get_functiondef(
    'public.commit_free_mode_actions(uuid,uuid,jsonb)'::regprocedure
  ) like '%v_chunk_count >= 100%',
  'commit serializes each target chunk and enforces its 100-block cap'
);
select ok(
  lower(pg_get_functiondef(
    'private.settle_locked_free_mode_inventory(uuid,uuid,timestamp with time zone)'::regprocedure
  )) like '%for update%'
  and pg_get_functiondef(
    'private.settle_locked_free_mode_inventory(uuid,uuid,timestamp with time zone)'::regprocedure
  ) like '%v_elapsed_hours * 5%',
  'hourly settlement locks state and grants five blocks per full hour'
);

delete from public.free_mode_operations
 where world_id = '00000000-0000-4000-8000-000000000001';
delete from public.free_mode_blocks
 where world_id = '00000000-0000-4000-8000-000000000001';
delete from public.free_mode_player_state
 where world_id = '00000000-0000-4000-8000-000000000001';
delete from public.player_world_state
 where world_id = '00000000-0000-4000-8000-000000000001';
delete from public.profiles
 where user_id in (
   '12000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000002'
 );
delete from auth.users
 where id in (
   '12000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000002'
 );

insert into auth.users (
  instance_id, id, aud, role, is_anonymous, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '12000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', true,
    clock_timestamp(), clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '12000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', true,
    clock_timestamp(), clock_timestamp()
  );

create temporary table free_mode_test_values (
  name text primary key,
  response jsonb
) on commit drop;

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '12000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;

select ok(
  public.get_player_identity(
    '00000000-0000-4000-8000-000000000001'
  ) #>> '{profile,public_tag}' like '#____',
  'identity bootstrap returns only the public profile needed by the start screen'
);
select is(
  (select count(*)::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000001'),
  0,
  'identity bootstrap does not start the free-mode timer or grant'
);
select is(
  (select count(*)::integer from public.player_world_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000001'),
  0,
  'identity bootstrap does not allocate a mission bay'
);

select is(
  (public.get_free_mode_overview(
    '00000000-0000-4000-8000-000000000001'
  ) #>> '{progress,inventory}')::integer,
  30,
  'first free-mode entry grants exactly 30 blocks'
);
select ok(
  (public.get_free_mode_overview(
    '00000000-0000-4000-8000-000000000001'
  ) #>> '{progress,initial_grant_claimed}')::boolean,
  'initial grant is recorded as claimed'
);
select is(
  (public.get_free_mode_overview(
    '00000000-0000-4000-8000-000000000001'
  ) #>> '{progress,inventory}')::integer,
  30,
  'overview retry never repeats the initial grant'
);
select is(
  (select count(*)::integer
     from public.player_world_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000001'),
  0,
  'entering free mode does not create or change mission-mode state'
);

update public.free_mode_player_state
   set last_settled_at = clock_timestamp() - interval '1 hour 1 second'
 where world_id = '00000000-0000-4000-8000-000000000001'
   and player_id = '12000000-0000-4000-8000-000000000001';
insert into free_mode_test_values (name, response)
values (
  'first-settlement',
  public.settle_free_mode_inventory(
    '00000000-0000-4000-8000-000000000001'
  )
);
select is(
  (select (response ->> 'produced')::integer
     from free_mode_test_values where name = 'first-settlement'),
  5,
  'one full DB-clock hour produces five blocks'
);
select is(
  (select (response #>> '{progress,inventory}')::integer
     from free_mode_test_values where name = 'first-settlement'),
  35,
  'hourly production is added to free-mode stock'
);

update public.free_mode_player_state
   set inventory = 98,
       last_settled_at = clock_timestamp() - interval '1 hour 1 second'
 where world_id = '00000000-0000-4000-8000-000000000001'
   and player_id = '12000000-0000-4000-8000-000000000001';
insert into free_mode_test_values (name, response)
values (
  'cap-settlement',
  public.settle_free_mode_inventory(
    '00000000-0000-4000-8000-000000000001'
  )
);
select is(
  (select (response ->> 'produced')::integer
     from free_mode_test_values where name = 'cap-settlement'),
  2,
  'settlement reports only blocks that fit below the cap'
);
select is(
  (select (response #>> '{progress,inventory}')::integer
     from free_mode_test_values where name = 'cap-settlement'),
  100,
  'free-mode stock is capped at 100'
);
update public.free_mode_player_state
   set inventory = 100,
       last_settled_at = clock_timestamp() - interval '30 minutes'
 where world_id = '00000000-0000-4000-8000-000000000001'
   and player_id = '12000000-0000-4000-8000-000000000001';
insert into free_mode_test_values (name, response)
select 'cap-before-noop', jsonb_build_object(
  'last_settled_at', extract(epoch from last_settled_at),
  'updated_at', extract(epoch from updated_at)
)
from public.free_mode_player_state
where world_id = '00000000-0000-4000-8000-000000000001'
  and player_id = '12000000-0000-4000-8000-000000000001';
select is(
  private.settle_locked_free_mode_inventory(
    '00000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000001',
    clock_timestamp()
  ),
  0,
  'settling at the cap produces nothing'
);
select is(
  (select extract(epoch from last_settled_at)::numeric
     from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000001'),
  (select (response ->> 'last_settled_at')::numeric
     from free_mode_test_values where name = 'cap-before-noop'),
  'settling at the cap does not move the production clock'
);
select is(
  (select extract(epoch from updated_at)::numeric
     from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000001'),
  (select (response ->> 'updated_at')::numeric
     from free_mode_test_values where name = 'cap-before-noop'),
  'settling at the cap performs no state update'
);
update public.free_mode_player_state
   set inventory = 99
 where world_id = '00000000-0000-4000-8000-000000000001'
   and player_id = '12000000-0000-4000-8000-000000000001';
select is(
  private.settle_locked_free_mode_inventory(
    '00000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000001',
    (select last_settled_at + interval '30 minutes'
       from public.free_mode_player_state
      where world_id = '00000000-0000-4000-8000-000000000001'
        and player_id = '12000000-0000-4000-8000-000000000001')
  ),
  0,
  'time spent full is not banked after one block is spent'
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000001'),
  99,
  'a partial post-cap interval does not refill stock early'
);
update public.free_mode_player_state
   set inventory = 100
 where world_id = '00000000-0000-4000-8000-000000000001'
   and player_id = '12000000-0000-4000-8000-000000000001';

insert into free_mode_test_values (name, response)
values (
  'place',
  public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000001',
      'x', 8, 'y', 1, 'z', 8,
      'kind', 'cube', 'rotation', 0, 'color_index', 2,
      'support_id', null
    ))
  )
);
select is(
  (select (response #>> '{progress,inventory}')::integer
     from free_mode_test_values where name = 'place'),
  99,
  'placing one free-mode block spends exactly one stock'
);
select is(
  (select response #>> '{progress,last_settled_at}'
     from free_mode_test_values where name = 'place'),
  (select response ->> 'server_now'
     from free_mode_test_values where name = 'place'),
  'spending from a full stock starts a fresh one-hour interval'
);

insert into free_mode_test_values (name, response)
values (
  'place-replay',
  public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000001',
      'x', 8, 'y', 1, 'z', 8,
      'kind', 'cube', 'rotation', 0, 'color_index', 2,
      'support_id', null
    ))
  )
);
select ok(
  (select (response ->> 'replayed')::boolean
     from free_mode_test_values where name = 'place-replay'),
  'same idempotency key and request replays the stored response'
);
select is(
  (select count(*)::integer from public.free_mode_blocks
    where id = '32000000-0000-4000-8000-000000000001'),
  1,
  'idempotent replay creates no duplicate block'
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000001'),
  99,
  'idempotent replay spends no additional stock'
);
select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'type', 'remove',
      'block_id', '32000000-0000-4000-8000-000000000001'
    ))
  )$$,
  '22023',
  'idempotency key was used with a different request',
  'an idempotency key cannot be reused for a different action'
);

insert into public.profiles (
  user_id, public_tag, nickname, emblem, created_at
) values (
  '12000000-0000-4000-8000-000000000002',
  '#Z999',
  '고요한 여우',
  '◆',
  clock_timestamp()
) on conflict (user_id) do nothing;

insert into public.free_mode_operations (
  world_id, player_id, operation_key, request_hash, response,
  created_at, completed_at
) values
  (
    '00000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000002',
    '22000000-0000-4000-8000-000000000099',
    decode(md5('expired-exact-key'), 'hex'),
    '{}'::jsonb,
    clock_timestamp() - interval '25 hours',
    clock_timestamp() - interval '25 hours'
  ),
  (
    '00000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000098',
    decode(md5('expired-cleanup-key'), 'hex'),
    '{}'::jsonb,
    clock_timestamp() - interval '25 hours',
    clock_timestamp() - interval '25 hours'
  );

insert into free_mode_test_values (name, response)
values (
  'own-remove',
  public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000099',
    jsonb_build_array(jsonb_build_object(
      'type', 'remove',
      'block_id', '32000000-0000-4000-8000-000000000001'
    ))
  )
);
select is(
  (select (response #>> '{progress,inventory}')::integer
     from free_mode_test_values where name = 'own-remove'),
  100,
  'an owner can remove immediately and recover one block'
);
select is(
  (select response #>> '{progress,last_settled_at}'
     from free_mode_test_values where name = 'own-remove'),
  (select response ->> 'server_now'
     from free_mode_test_values where name = 'own-remove'),
  'a refund that fills stock starts a fresh interval at the cap'
);
select is(
  (select count(*)::integer from public.free_mode_blocks
    where id = '32000000-0000-4000-8000-000000000001'),
  0,
  'owner removal deletes the authoritative block'
);
select is(
  (select count(*)::integer
     from public.free_mode_operations
    where operation_key = '22000000-0000-4000-8000-000000000098'),
  0,
  'a successful commit reuses an expired exact key and prunes another actor expired response'
);
select is(
  (select count(*)::integer
     from public.free_mode_operations
    where operation_key = '22000000-0000-4000-8000-000000000001'),
  1,
  'idempotency responses inside the 24-hour guarantee remain replayable'
);

insert into free_mode_test_values (name, response)
values (
  'foreign-target',
  public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000003',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000002',
      'x', 9, 'y', 1, 'z', 8,
      'kind', 'light', 'rotation', 0, 'color_index', 4
    ))
  )
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000001'),
  99,
  'the foreign-removal fixture spends its owner stock once'
);

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '12000000-0000-4000-8000-000000000002',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;

select is(
  (public.get_free_mode_overview(
    '00000000-0000-4000-8000-000000000001'
  ) #>> '{progress,inventory}')::integer,
  30,
  'a second player receives an isolated 30-block stock'
);
select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000012',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000012',
      'x', 0, 'y', 5, 'z', 0,
      'kind', 'cube', 'rotation', 0, 'color_index', 0
    ))
  )$$,
  '42501',
  'protected zone cannot be modified',
  'free-mode placement cannot overlap the deterministic central tower'
);
select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000014',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000014',
      'x', 0, 'y', 1, 'z', -29,
      'kind', 'cube', 'rotation', 0, 'color_index', 0
    ))
  )$$,
  '42501',
  'protected zone cannot be modified',
  'free-mode placement cannot block the shared spawn'
);
select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000015',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000015',
      'x', 40, 'y', 1, 'z', 40,
      'kind', 'cube', 'rotation', 0, 'color_index', 0
    ))
  )$$,
  '23503',
  'ground cell does not exist at this coordinate',
  'free-mode placement cannot create a ground block over the void'
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000002'),
  30,
  'protected-system rejection leaves stock unchanged'
);
select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000013',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000013',
      'x', 45, 'y', 2, 'z', 40,
      'kind', 'cube', 'rotation', 0, 'color_index', 0
    ))
  )$$,
  '23503',
  'free-mode blocks above ground require supportId',
  'free-mode placement above ground requires a real support block'
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000002'),
  30,
  'unsupported floating placement leaves stock unchanged'
);
select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000004',
    jsonb_build_array(jsonb_build_object(
      'type', 'remove',
      'block_id', '32000000-0000-4000-8000-000000000002'
    ))
  )$$,
  'P0004',
  'another player block is protected for 72 hours',
  'another player cannot remove a block before three days'
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000002'),
  30,
  'failed early removal does not change requester stock'
);
select is(
  (select count(*)::integer from public.free_mode_blocks
    where id = '32000000-0000-4000-8000-000000000002'),
  1,
  'failed early removal leaves the block intact'
);

update public.free_mode_blocks
   set created_at = clock_timestamp() - interval '72 hours 1 second'
 where id = '32000000-0000-4000-8000-000000000002';
insert into free_mode_test_values (name, response)
values (
  'foreign-remove',
  public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000005',
    jsonb_build_array(jsonb_build_object(
      'type', 'remove',
      'block_id', '32000000-0000-4000-8000-000000000002'
    ))
  )
);
select is(
  (select response #>> '{removed_block_ids,0}'
     from free_mode_test_values where name = 'foreign-remove'),
  '32000000-0000-4000-8000-000000000002',
  'another player can remove the block after 72 hours'
);
select is(
  (select count(*)::integer from public.free_mode_blocks
    where id = '32000000-0000-4000-8000-000000000002'),
  0,
  'expired foreign block is deleted'
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000002'),
  30,
  'foreign removal grants no stock to the remover'
);

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '12000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000001'),
  99,
  'foreign removal does not refund the original owner'
);

insert into free_mode_test_values (name, response)
values (
  'collision-owner',
  public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000006',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000003',
      'x', 10, 'y', 1, 'z', 8,
      'kind', 'stair', 'rotation', 1, 'color_index', 3
    ))
  )
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000001'),
  98,
  'first coordinate claimant spends one block'
);

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '12000000-0000-4000-8000-000000000002',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;
select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000007',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000004',
      'x', 10, 'y', 1, 'z', 8,
      'kind', 'cube', 'rotation', 0, 'color_index', 0
    ))
  )$$,
  '23505',
  'block id or coordinate is already occupied',
  'a second claimant loses the coordinate collision'
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000002'),
  30,
  'coordinate collision rolls requester stock back'
);
select is(
  (select count(*)::integer from public.free_mode_blocks
    where world_id = '00000000-0000-4000-8000-000000000001'
      and x = 10 and y = 1 and z = 8),
  1,
  'coordinate uniqueness leaves exactly one authoritative block'
);

select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000008',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000005',
      'x', 11, 'y', 1, 'z', 8,
      'kind', 'cube', 'rotation', 0, 'color_index', 12
    ))
  )$$,
  '22023',
  'place action is outside world or palette bounds',
  'palette indexes outside the allowlist are rejected'
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000002'),
  30,
  'invalid placement leaves stock unchanged'
);
select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000009',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000006',
      'x', 12, 'y', 1, 'z', 8,
      'kind', 'cube', 'rotation', 0, 'color_index', 0,
      'padding', repeat('x', 33000)
    ))
  )$$,
  '22023',
  'action payload exceeds 32768 bytes',
  'oversized free-mode payload is rejected before mutation'
);
select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000010',
    (select jsonb_agg(jsonb_build_object(
      'type', 'remove',
      'block_id', extensions.gen_random_uuid()
    )) from generate_series(1, 25))
  )$$,
  '22023',
  'exactly one free-mode action is required',
  'a free-mode commit accepts exactly one action'
);
select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000011',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000007',
      'x', 12, 'y', 1, 'z', 8,
      'kind', 'cube', 'rotation', 0, 'color_index', 0,
      'client_time', '2099-01-01T00:00:00Z'
    ))
  )$$,
  '22023',
  'place action contains unsupported fields',
  'client timestamps and unknown fields are rejected'
);
select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000014',
    jsonb_build_array(
      jsonb_build_object(
        'type', 'place',
        'block_id', '32000000-0000-4000-8000-000000000008',
        'x', 12, 'y', 1, 'z', 8,
        'kind', 'cube', 'rotation', 0, 'color_index', 0
      ),
      jsonb_build_object(
        'type', 'remove',
        'block_id', '32000000-0000-4000-8000-000000000008'
      )
    )
  )$$,
  '22023',
  'each block id may appear only once per commit',
  'one commit cannot place and remove the same block id'
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000002'),
  30,
  'duplicate block actions leave stock unchanged'
);
select is(
  (public.get_nearby_free_mode_blocks(
    '00000000-0000-4000-8000-000000000001', 0, 0, 0, 1, 1
  ) ->> 'block_count')::integer,
  1,
  'bounded free-mode chunk read returns the surviving block'
);
select ok(
  (public.get_nearby_free_mode_blocks(
    '00000000-0000-4000-8000-000000000001', 0, 0, 0, 1, 1
  ) #>> '{blocks,0,removable_by_others_at}')::timestamptz
    = (select created_at + interval '72 hours'
         from public.free_mode_blocks
        where id = '32000000-0000-4000-8000-000000000003'),
  'public block response publishes the predictable removal time'
);
select ok(
  (select response::text
     from free_mode_test_values where name = 'collision-owner')
    not like '%12000000-0000-4000-8000-000000000001%',
  'mutation response does not expose internal auth UID'
);
select is(
  (select count(*)::integer
     from public.free_mode_operations
    where world_id = '00000000-0000-4000-8000-000000000001'
      and operation_key = '22000000-0000-4000-8000-000000000007'),
  0,
  'failed coordinate collision creates no idempotency success row'
);
select is(
  (select count(*)::integer
     from information_schema.columns
    where table_schema = 'public'
      and table_name like 'free_mode_%'
      and column_name in ('ip', 'ip_address', 'client_ip', 'remote_ip')),
  0,
  'free-mode tables store no IP field'
);

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '12000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;
insert into free_mode_test_values (name, response)
values (
  'support-parent',
  public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000030',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000030',
      'x', 11, 'y', 1, 'z', 9,
      'kind', 'cube', 'rotation', 0, 'color_index', 2
    ))
  )
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000001'),
  97,
  'support-parent placement spends owner A stock once'
);

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '12000000-0000-4000-8000-000000000002',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;
insert into free_mode_test_values (name, response)
values (
  'support-child',
  public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000031',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000031',
      'x', 11, 'y', 2, 'z', 9,
      'kind', 'light', 'rotation', 0, 'color_index', 4,
      'support_id', '32000000-0000-4000-8000-000000000030'
    ))
  )
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000002'),
  29,
  'support-child placement spends owner B stock once'
);
update public.free_mode_blocks
   set created_at = clock_timestamp() - interval '72 hours 1 second'
 where id = '32000000-0000-4000-8000-000000000030';
select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000032',
    jsonb_build_array(jsonb_build_object(
      'type', 'remove',
      'block_id', '32000000-0000-4000-8000-000000000030'
    ))
  )$$,
  'P0005',
  'block is supporting another block',
  'a foreign remover remains blocked by a child after 72 hours'
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000002'),
  29,
  'foreign support rejection leaves requester stock unchanged'
);
select is(
  (select count(*)::integer from public.free_mode_blocks
    where id = '32000000-0000-4000-8000-000000000030'),
  1,
  'foreign support rejection leaves the parent intact'
);

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '12000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;
insert into free_mode_test_values (name, response)
values (
  'support-owner-remove',
  public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000033',
    jsonb_build_array(jsonb_build_object(
      'type', 'remove',
      'block_id', '32000000-0000-4000-8000-000000000030'
    ))
  )
);
select is(
  (select response #>> '{removed_block_ids,0}'
     from free_mode_test_values where name = 'support-owner-remove'),
  '32000000-0000-4000-8000-000000000030',
  'owner A can immediately reclaim a parent used by owner B'
);
select ok(
  (select response #> '{upserted_blocks,0,support_id}'
     from free_mode_test_values where name = 'support-owner-remove')
    = 'null'::jsonb,
  'owner removal returns the detached child as an authoritative upsert'
);
select is(
  (select support_id from public.free_mode_blocks
    where id = '32000000-0000-4000-8000-000000000031'),
  null::uuid,
  'owner removal atomically clears the child support reference'
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000001'),
  98,
  'owner A receives exactly one refunded block'
);
select ok(
  (public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000033',
    jsonb_build_array(jsonb_build_object(
      'type', 'remove',
      'block_id', '32000000-0000-4000-8000-000000000030'
    ))
  ) ->> 'replayed')::boolean,
  'owner removal retry replays its stored result'
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000001'),
  98,
  'owner removal retry does not refund stock twice'
);

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '12000000-0000-4000-8000-000000000002',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;
insert into free_mode_test_values (name, response)
values (
  'support-child-remove',
  public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000034',
    jsonb_build_array(jsonb_build_object(
      'type', 'remove',
      'block_id', '32000000-0000-4000-8000-000000000031'
    ))
  )
);
select is(
  (select response #>> '{removed_block_ids,0}'
     from free_mode_test_values where name = 'support-child-remove'),
  '32000000-0000-4000-8000-000000000031',
  'owner B can reclaim the detached child immediately'
);
select is(
  (select inventory::integer from public.free_mode_player_state
    where world_id = '00000000-0000-4000-8000-000000000001'
      and player_id = '12000000-0000-4000-8000-000000000002'),
  30,
  'owner B receives exactly one child refund'
);

insert into public.free_mode_blocks (
  id, world_id, x, y, z, kind, rotation, color_index,
  creator_id, creator_public_tag, nickname_snapshot, creator_emblem, created_at
)
select
  md5('free-chunk-cap-' || value::text)::uuid,
  '00000000-0000-4000-8000-000000000001',
  160 + (value % 16), 1, 160 + floor(value / 16)::integer,
  'cube', 0, 0,
  '12000000-0000-4000-8000-000000000002',
  profile.public_tag, profile.nickname, profile.emblem, clock_timestamp()
from generate_series(0, 99) as value
cross join public.profiles as profile
where profile.user_id = '12000000-0000-4000-8000-000000000002';

select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000015',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000015',
      'x', 160, 'y', 2, 'z', 160,
      'support_id', md5('free-chunk-cap-0')::uuid,
      'kind', 'cube', 'rotation', 0, 'color_index', 0
    ))
  )$$,
  '54000',
  'free-mode chunk has reached the 100-block limit',
  'a placement cannot cross the free-mode chunk density cap'
);
select is(
  (select count(*)::integer from public.free_mode_blocks
    where world_id = '00000000-0000-4000-8000-000000000001'
      and chunk_x = 10 and chunk_y = 0 and chunk_z = 10),
  100,
  'chunk-cap rejection leaves the full chunk unchanged'
);

with operation_count as (
  select count(*)::integer as value
    from public.free_mode_operations
   where world_id = '00000000-0000-4000-8000-000000000001'
     and player_id = '12000000-0000-4000-8000-000000000002'
     and created_at >= clock_timestamp() - interval '24 hours'
)
insert into public.free_mode_operations (
  world_id, player_id, operation_key, request_hash, response,
  created_at, completed_at
)
select
  '00000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000002',
  md5('free-rate-limit-' || generated.sequence_no::text)::uuid,
  decode(md5('free-rate-limit-' || generated.sequence_no::text), 'hex'),
  '{}'::jsonb, clock_timestamp(), clock_timestamp()
from operation_count
cross join lateral generate_series(
  1, greatest(0, 240 - operation_count.value)
) as generated(sequence_no);

select ok(
  (public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000005',
    jsonb_build_array(jsonb_build_object(
      'type', 'remove',
      'block_id', '32000000-0000-4000-8000-000000000002'
    ))
  ) ->> 'replayed')::boolean,
  'an exact retry remains available after the daily write limit'
);

select throws_ok(
  $$select public.commit_free_mode_actions(
    '00000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000017',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '32000000-0000-4000-8000-000000000017',
      'x', 190, 'y', 1, 'z', 190,
      'kind', 'cube', 'rotation', 0, 'color_index', 0
    ))
  )$$,
  'P0003',
  'free-mode daily mutation limit reached',
  'owner place/remove loops are bounded to 240 confirmed writes per 24 hours'
);
select is(
  (select count(*)::integer from public.free_mode_blocks
    where id = '32000000-0000-4000-8000-000000000017'),
  0,
  'daily-limit rejection leaves the world unchanged'
);

select * from finish();
rollback;
