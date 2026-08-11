begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, private, extensions, pg_catalog;

select plan(65);

select ok(to_regclass('public.profiles') is not null, 'profiles table exists');
select ok(to_regclass('public.worlds') is not null, 'worlds table exists');
select ok(to_regclass('public.player_world_state') is not null, 'player state table exists');
select ok(to_regclass('public.blocks') is not null, 'blocks table exists');
select ok(to_regclass('public.idempotent_operations') is not null, 'idempotency table exists');
select ok(to_regclass('public.dismantle_tickets') is not null, 'dismantle ticket table exists');

select ok(
  (select bool_and(c.relrowsecurity)
     from pg_class as c
     join pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'profiles', 'worlds', 'player_world_state', 'blocks',
        'idempotent_operations', 'dismantle_tickets'
      )),
  'every application table has RLS enabled'
);
select ok(not has_table_privilege('authenticated', 'public.blocks', 'INSERT'), 'blocks direct insert denied');
select ok(not has_table_privilege('authenticated', 'public.blocks', 'UPDATE'), 'blocks direct update denied');
select ok(not has_table_privilege('authenticated', 'public.blocks', 'DELETE'), 'blocks direct delete denied');
select ok(not has_table_privilege('authenticated', 'public.profiles', 'SELECT'), 'profile UID cannot be selected');
select ok(not has_table_privilege('authenticated', 'public.player_world_state', 'SELECT'), 'private progress cannot be selected');

select ok(to_regprocedure('public.bootstrap_player(uuid)') is not null, 'bootstrap RPC exists');
select ok(
  to_regprocedure('public.get_nearby_blocks(uuid,integer,integer,integer,integer,integer)') is not null,
  '3D nearby RPC exists'
);
select ok(
  to_regprocedure('public.get_nearby_blocks(uuid,integer,integer,integer)') is null,
  'unbounded vertical nearby RPC was removed'
);
select ok(
  exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'blocks' and column_name = 'chunk_y'
  ),
  'blocks have a generated vertical chunk coordinate'
);
select ok(
  to_regclass('public.blocks_world_chunk_3d_idx') is not null,
  '3D nearby lookup index exists'
);
select ok(
  pg_get_functiondef(
    'public.get_nearby_blocks(uuid,integer,integer,integer,integer,integer)'::regprocedure
  ) like '%p_vertical_radius not between 0 and 1%'
  and pg_get_functiondef(
    'public.get_nearby_blocks(uuid,integer,integer,integer,integer,integer)'::regprocedure
  ) like '%limit 8193%'
  and pg_get_functiondef(
    'public.get_nearby_blocks(uuid,integer,integer,integer,integer,integer)'::regprocedure
  ) like '%nearby block response exceeds 8192 rows%',
  'nearby RPC bounds vertical chunks and rejects overflow instead of truncating'
);
select ok(to_regprocedure('public.commit_world_actions(uuid,uuid,jsonb)') is not null, 'commit RPC exists');
select ok(to_regprocedure('public.settle_production(uuid)') is not null, 'settlement RPC exists');
select ok(to_regprocedure('public.start_manual_production(uuid,uuid)') is not null, 'manual start RPC exists');
select ok(to_regprocedure('public.complete_manual_production(uuid,uuid,uuid)') is not null, 'manual finish RPC exists');
select ok(to_regprocedure('public.start_dismantle(uuid,uuid,uuid)') is not null, 'dismantle start RPC exists');
select ok(to_regprocedure('public.cancel_dismantle(uuid,uuid)') is not null, 'dismantle cancel RPC exists');
select ok(to_regprocedure('public.finish_dismantle(uuid,uuid,uuid)') is not null, 'dismantle finish RPC exists');

select is((select origin_x from private.starter_slot_geometry(0)), 0, 'slot 0 x matches client');
select is((select origin_z from private.starter_slot_geometry(0)), -26, 'slot 0 z matches client');
select is((select origin_z from private.starter_slot_geometry(8)), -52, 'second ring matches client');
select is(
  (select guide_group from private.guide_at(0, 0, 2, -27)),
  'base',
  'base core guide matches client coordinates'
);
select is(
  (select zone from private.position_zone('00000000-0000-4000-8000-000000000001', 0, 0)),
  'mission',
  'central mission area is protected'
);

select ok(
  pg_get_functiondef('public.commit_world_actions(uuid,uuid,jsonb)'::regprocedure)
    like '%jsonb_array_length(p_actions)%',
  'commit validates action array size'
);
select ok(
  pg_get_functiondef('public.commit_world_actions(uuid,uuid,jsonb)'::regprocedure)
    like '%octet_length(p_actions::text) > 32768%',
  'commit rejects oversized action payloads'
);
select ok(
  pg_get_functiondef('public.commit_world_actions(uuid,uuid,jsonb)'::regprocedure)
    like '%private.request_hash%',
  'commit hashes the full idempotent request'
);
select ok(
  pg_get_functiondef('private.require_actor()'::regprocedure)
    like '%is_anonymous%',
  'RPC boundary requires an anonymous JWT'
);
select ok(
  pg_get_functiondef('private.settle_locked_production(uuid,uuid,timestamp with time zone)'::regprocedure)
    like '%p_now - v_state.last_settled_at%',
  'automatic production uses a server-supplied DB timestamp'
);
select ok(
  pg_get_functiondef('public.start_dismantle(uuid,uuid,uuid)'::regprocedure)
    like '%2.5 seconds%',
  'foreign dismantle uses a DB-clock 2.5 second hold'
);
select ok(
  pg_get_functiondef('private.block_public_json(public.blocks)'::regprocedure)
    not like '%creator_id%',
  'public block JSON never exposes auth UID'
);
select is(
  (
    select count(*)::integer
      from information_schema.columns
     where table_schema in ('public', 'private')
       and column_name in ('ip', 'ip_address', 'client_ip', 'remote_ip')
  ),
  0,
  'application tables and operator views do not store IP fields'
);

-- RPC semantics use two anonymous auth actors. Claims are server-session state;
-- no client timestamp is accepted by any mutation RPC.
-- Clear this world's mutable rows inside the test transaction so a prior HTTP
-- integration run cannot change the expected slot indexes; ROLLBACK restores it.
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
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', true, clock_timestamp(), clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', true, clock_timestamp(), clock_timestamp()
  );

create temporary table stage3_rpc_values (
  name text primary key,
  operation_key uuid,
  payload jsonb,
  response jsonb
) on commit drop;

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '10000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;

select is(
  (public.bootstrap_player('00000000-0000-4000-8000-000000000001')
    #>> '{state,starter_slot}')::integer,
  0,
  'first anonymous player receives slot 0'
);
select is(
  (public.bootstrap_player('00000000-0000-4000-8000-000000000001')
    #>> '{state,inventory}')::integer,
  24,
  'first bootstrap grants exactly 24 blocks'
);
select is(
  (public.bootstrap_player('00000000-0000-4000-8000-000000000001')
    #>> '{state,starter_slot}')::integer,
  0,
  'bootstrap retry preserves the same slot'
);
select throws_ok(
  $$select public.commit_world_actions(
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000099',
    jsonb_build_array(jsonb_build_object(
      'type', 'place',
      'block_id', '30000000-0000-4000-8000-000000000099',
      'x', 500, 'y', 0, 'z', 499,
      'kind', 'cube', 'rotation', 0, 'color_index', 0,
      'padding', repeat('x', 33000)
    ))
  )$$,
  '22023',
  'action payload exceeds 32768 bytes',
  'oversized commit payload is rejected before mutation'
);
select throws_ok(
  $$select public.get_public_profiles(array[repeat('x', 33000)])$$,
  '22023',
  'invalid public profile tag',
  'public profile lookup accepts only fixed-size public tags'
);

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '10000000-0000-4000-8000-000000000002',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;
select is(
  (public.bootstrap_player('00000000-0000-4000-8000-000000000001')
    #>> '{state,starter_slot}')::integer,
  1,
  'second anonymous player receives a non-overlapping slot'
);

-- Build actor 1's exact 16+8 onboarding guides in one atomic commit.
insert into stage3_rpc_values (name, operation_key, payload)
select
  'onboarding',
  '20000000-0000-4000-8000-000000000001',
  jsonb_agg(
    jsonb_build_object(
      'type', 'place',
      'block_id', extensions.gen_random_uuid(),
      'x', coordinates.x,
      'y', coordinates.y,
      'z', coordinates.z,
      'kind', guide.expected_kind,
      'rotation', guide.expected_rotation,
      'color_index', 0,
      'support_id', null
    ) order by guide.guide_group, coordinates.y, coordinates.z, coordinates.x
  )
from generate_series(-2, 5) as gx(x)
cross join generate_series(1, 3) as gy(y)
cross join generate_series(-28, -25) as gz(z)
cross join lateral (
  select gx.x as x, gy.y as y, gz.z as z
) as coordinates
cross join lateral private.guide_at(
  0, coordinates.x, coordinates.y, coordinates.z
) as guide
where guide.guide_group in ('base', 'producer');

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '10000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;
update stage3_rpc_values
   set response = public.commit_world_actions(
     '00000000-0000-4000-8000-000000000001', operation_key, payload
   )
 where name = 'onboarding';

select is(
  (select (response #>> '{progress,inventory}')::integer
     from stage3_rpc_values where name = 'onboarding'),
  2,
  '16+8 completion spends 24 and grants the one-time 2 block reward'
);
select is(
  (select count(*)::integer from public.blocks
    where world_id = '00000000-0000-4000-8000-000000000001'
      and creator_id = '10000000-0000-4000-8000-000000000001'),
  24,
  'onboarding commit inserts all 24 blocks'
);
select ok(
  (select (public.commit_world_actions(
    '00000000-0000-4000-8000-000000000001', operation_key, payload
  ) ->> 'replayed')::boolean from stage3_rpc_values where name = 'onboarding'),
  'same idempotency key and payload replays the stored response'
);
select is(
  (select count(*)::integer from public.blocks
    where world_id = '00000000-0000-4000-8000-000000000001'
      and creator_id = '10000000-0000-4000-8000-000000000001'),
  24,
  'idempotent replay creates no duplicate blocks'
);
select throws_ok(
  $$select public.commit_world_actions(
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '[{"type":"reset_onboarding"}]'::jsonb
  )$$,
  '22023',
  'idempotency key was used with a different request',
  'same key with a different payload is rejected'
);

select lives_ok(
  $$select public.commit_world_actions(
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    '[{"type":"place","block_id":"30000000-0000-4000-8000-000000000001","x":500,"y":0,"z":500,"kind":"cube","rotation":0,"color_index":1,"support_id":null}]'::jsonb
  )$$,
  'first public coordinate placement succeeds'
);
select is(
  jsonb_array_length(
    public.get_nearby_blocks(
      '00000000-0000-4000-8000-000000000001', 31, 2, 31, 0, 0
    ) -> 'blocks'
  ),
  0,
  'nearby read excludes the same X/Z column outside the requested vertical chunk'
);
select is(
  (
    public.get_nearby_blocks(
      '00000000-0000-4000-8000-000000000001', 31, 0, 31, 0, 0
    ) ->> 'block_count'
  )::integer,
  1,
  'nearby read reports the exact returned row count'
);
select is(
  (
    public.get_nearby_blocks(
      '00000000-0000-4000-8000-000000000001', 31, 0, 31, 0, 0
    ) ->> 'block_limit'
  )::integer,
  8192,
  'nearby read publishes the parser contract row limit'
);

-- Actor 2 is advanced only as test setup so server permission and coordinate
-- competition paths can be exercised without duplicating a second 24-action build.
update public.player_world_state
   set inventory = 5,
       base_completed = true,
       base_completed_at = clock_timestamp(),
       producer_completed = true,
       producer_completed_at = clock_timestamp(),
       trial_reward_claimed = true,
       last_settled_at = clock_timestamp()
 where world_id = '00000000-0000-4000-8000-000000000001'
   and player_id = '10000000-0000-4000-8000-000000000002';

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '10000000-0000-4000-8000-000000000002',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;
select throws_ok(
  $$select public.commit_world_actions(
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000007',
    '[{"type":"place","block_id":"30000000-0000-4000-8000-000000000006","x":10,"y":0,"z":10,"kind":"cube","rotation":0,"color_index":2,"support_id":null}]'::jsonb
  )$$,
  '42501',
  'deterministic system cell cannot be modified',
  'central deterministic ground cannot be overwritten'
);
select throws_ok(
  $$select public.commit_world_actions(
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000008',
    '[{"type":"place","block_id":"30000000-0000-4000-8000-000000000007","x":0,"y":0,"z":-26,"kind":"cube","rotation":0,"color_index":2,"support_id":null}]'::jsonb
  )$$,
  '42501',
  'deterministic system cell cannot be modified',
  'starter bay platform cannot be overwritten'
);
select throws_ok(
  $$select public.commit_world_actions(
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000003',
    '[{"type":"place","block_id":"30000000-0000-4000-8000-000000000002","x":500,"y":0,"z":500,"kind":"cube","rotation":0,"color_index":2,"support_id":null}]'::jsonb
  )$$,
  '23505',
  'block id or coordinate is already occupied',
  'second player loses the same-coordinate race atomically'
);
select throws_ok(
  $$select public.commit_world_actions(
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000004',
    '[{"type":"place","block_id":"30000000-0000-4000-8000-000000000003","x":0,"y":5,"z":-26,"kind":"cube","rotation":0,"color_index":2,"support_id":null}]'::jsonb
  )$$,
  '42501',
  'private bay belongs to another player or is unassigned',
  'another player cannot modify a private bay'
);

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '10000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;
select lives_ok(
  $$select public.commit_world_actions(
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    '[{"type":"place","block_id":"30000000-0000-4000-8000-000000000004","x":498,"y":0,"z":500,"kind":"cube","rotation":0,"color_index":3,"support_id":null,"created_at":"2099-01-01T00:00:00Z"}]'::jsonb
  )$$,
  'client-supplied future time is ignored by placement'
);
select ok(
  (select created_at < '2090-01-01'::timestamptz
     from public.blocks where id = '30000000-0000-4000-8000-000000000004'),
  'stored creation time comes from the DB clock'
);
select throws_ok(
  $$select public.commit_world_actions(
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000006',
    '[{"type":"place","block_id":"30000000-0000-4000-8000-000000000005","x":499,"y":0,"z":500,"kind":"cube","rotation":0,"color_index":4,"support_id":null}]'::jsonb
  )$$,
  '22023',
  'insufficient inventory',
  'inventory shortage rolls back the mutation'
);

insert into stage3_rpc_values (name, operation_key, response)
values (
  'manual',
  '40000000-0000-4000-8000-000000000001',
  public.start_manual_production(
    '00000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001'
  )
);
select ok(
  (select (response ->> 'ready_at')::timestamptz
        >= (response ->> 'server_now')::timestamptz + interval '15 seconds'
     from stage3_rpc_values where name = 'manual'),
  'manual production readiness is based on DB time'
);
select throws_ok(
  $$select public.complete_manual_production(
    '00000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000002'
  )$$,
  '22023',
  'manual production is not ready',
  'immediate manual completion is rejected by server time'
);

do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '10000000-0000-4000-8000-000000000002',
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
end;
$$;
insert into stage3_rpc_values (name, operation_key, response)
values (
  'dismantle',
  '50000000-0000-4000-8000-000000000001',
  public.start_dismantle(
    '00000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001'
  )
);
select ok(
  (select (response ->> 'ready_at')::timestamptz
        >= (response ->> 'server_now')::timestamptz + interval '2.5 seconds'
     from stage3_rpc_values where name = 'dismantle'),
  'dismantle readiness is based on the DB 2.5 second hold'
);
select throws_ok(
  $$select public.finish_dismantle(
    '00000000-0000-4000-8000-000000000001',
    (select (response ->> 'ticket_id')::uuid from stage3_rpc_values where name = 'dismantle'),
    '50000000-0000-4000-8000-000000000002'
  )$$,
  '22023',
  'dismantle hold has not reached 2.5 seconds',
  'immediate foreign dismantle finish is rejected'
);
select ok(
  (select (public.cancel_dismantle(
    '00000000-0000-4000-8000-000000000001',
    (response ->> 'ticket_id')::uuid
  ) ->> 'cancelled')::boolean from stage3_rpc_values where name = 'dismantle'),
  'cancel immediately invalidates the pending hold'
);

select * from finish();
rollback;
