begin;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

create type public.block_kind as enum ('cube', 'stair', 'light');
create type public.block_zone as enum (
  'system',
  'personal',
  'producer',
  'public',
  'mission'
);
create type public.block_source as enum ('onboarding', 'inventory', 'system');
create type public.operation_status as enum ('pending', 'completed', 'cancelled');
create type public.dismantle_status as enum ('pending', 'finished', 'cancelled', 'expired');

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  public_tag text not null unique,
  nickname text not null,
  emblem text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint profiles_public_tag_format
    check (public_tag ~ '^#[A-HJ-NP-Z2-9]{4}$'),
  constraint profiles_nickname_allowlist
    check (
      nickname ~ '^(고요한|빛나는|푸른|따뜻한|용감한|느긋한) (여우|수달|참새|고래|토끼|사슴)$'
    ),
  constraint profiles_emblem_allowlist
    check (emblem in ('◆', '●', '▲', '■', '✦', '⬟'))
);

create table public.worlds (
  id uuid primary key,
  slug text not null unique,
  title text not null,
  enabled boolean not null default true,
  starter_slot_capacity smallint not null default 64
    check (starter_slot_capacity between 1 and 4096),
  created_at timestamptz not null default clock_timestamp()
);

create table public.player_world_state (
  world_id uuid not null references public.worlds(id) on delete cascade,
  player_id uuid not null references public.profiles(user_id) on delete cascade,
  starter_slot integer not null check (starter_slot >= 0),
  inventory smallint not null default 24 check (inventory between 0 and 36),
  initial_grant_claimed boolean not null default true,
  base_completed boolean not null default false,
  base_completed_at timestamptz,
  producer_completed boolean not null default false,
  producer_completed_at timestamptz,
  trial_reward_claimed boolean not null default false,
  production_level smallint not null default 1 check (production_level in (1, 2)),
  producer_upgrade_completed_at timestamptz,
  last_settled_at timestamptz not null default clock_timestamp(),
  manual_production_at timestamptz[] not null default '{}',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (world_id, player_id),
  unique (world_id, starter_slot),
  constraint player_world_state_completion_timestamps check (
    (not base_completed or base_completed_at is not null)
    and (not producer_completed or producer_completed_at is not null)
    and (production_level = 1 or producer_upgrade_completed_at is not null)
  )
);

create table public.blocks (
  id uuid primary key,
  world_id uuid not null references public.worlds(id) on delete cascade,
  x integer not null check (x between -512 and 512),
  y integer not null check (y between 0 and 32760),
  z integer not null check (z between -512 and 512),
  chunk_x integer generated always as (floor(x::numeric / 16)::integer) stored,
  chunk_z integer generated always as (floor(z::numeric / 16)::integer) stored,
  kind public.block_kind not null,
  rotation smallint not null check (rotation between 0 and 3),
  color_index smallint not null check (color_index between 0 and 11),
  creator_id uuid not null references public.profiles(user_id) on delete restrict,
  creator_public_tag text not null,
  nickname_snapshot text not null,
  creator_emblem text not null,
  zone public.block_zone not null,
  zone_slot integer,
  support_id uuid references public.blocks(id)
    on delete no action deferrable initially deferred,
  source public.block_source not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (world_id, x, y, z),
  constraint blocks_support_not_self check (support_id is null or support_id <> id),
  constraint blocks_private_zone_slot check (
    (zone in ('personal', 'producer') and zone_slot is not null)
    or (zone not in ('personal', 'producer') and zone_slot is null)
  )
);

create index blocks_world_chunk_idx
  on public.blocks (world_id, chunk_x, chunk_z, y);
create index blocks_support_idx
  on public.blocks (support_id)
  where support_id is not null;
create index blocks_creator_idx
  on public.blocks (world_id, creator_id);

create table public.idempotent_operations (
  world_id uuid not null references public.worlds(id) on delete cascade,
  player_id uuid not null references public.profiles(user_id) on delete cascade,
  operation_key uuid not null,
  operation_kind text not null check (
    operation_kind in ('world-commit', 'manual-start', 'manual-complete', 'dismantle-finish')
  ),
  request_hash bytea not null,
  status public.operation_status not null default 'pending',
  ready_at timestamptz,
  expires_at timestamptz,
  response jsonb,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  primary key (world_id, player_id, operation_key)
);

create table public.dismantle_tickets (
  id uuid primary key default extensions.gen_random_uuid(),
  world_id uuid not null references public.worlds(id) on delete cascade,
  player_id uuid not null references public.profiles(user_id) on delete cascade,
  block_id uuid not null,
  start_idempotency_key uuid not null,
  status public.dismantle_status not null default 'pending',
  started_at timestamptz not null,
  ready_at timestamptz not null,
  expires_at timestamptz not null,
  finished_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (world_id, player_id, start_idempotency_key),
  constraint dismantle_ticket_time_order check (
    started_at < ready_at and ready_at < expires_at
  )
);

create index dismantle_tickets_active_idx
  on public.dismantle_tickets (world_id, player_id, status);

alter table public.profiles enable row level security;
alter table public.worlds enable row level security;
alter table public.player_world_state enable row level security;
alter table public.blocks enable row level security;
alter table public.idempotent_operations enable row level security;
alter table public.dismantle_tickets enable row level security;

-- No table policy is intentional. Browser access is restricted to the narrowly
-- scoped SECURITY DEFINER RPCs. In particular, auth UID and mutation rows are
-- never exposed by a direct table SELECT.
revoke all on table public.profiles from anon, authenticated;
revoke all on table public.worlds from anon, authenticated;
revoke all on table public.player_world_state from anon, authenticated;
revoke all on table public.blocks from anon, authenticated;
revoke all on table public.idempotent_operations from anon, authenticated;
revoke all on table public.dismantle_tickets from anon, authenticated;

comment on table public.profiles is
  'Internal auth UID plus allow-listed public identity. Read only through safe RPC fields.';
comment on table public.blocks is
  'Authoritative world mutations. Direct browser writes are forbidden; RPCs derive zones.';
comment on table public.idempotent_operations is
  'Per-player mutation replay protection and DB-clock manual production sessions.';

commit;
