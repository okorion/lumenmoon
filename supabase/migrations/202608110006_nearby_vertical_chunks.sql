begin;

alter table public.blocks
  add column chunk_y integer
  generated always as (floor(y::numeric / 16)::integer) stored;

create index blocks_world_chunk_3d_idx
  on public.blocks (world_id, chunk_x, chunk_y, chunk_z, created_at, id);

revoke execute on function public.get_nearby_blocks(uuid, integer, integer, integer)
  from public, anon, authenticated;
drop function public.get_nearby_blocks(uuid, integer, integer, integer);

create function public.get_nearby_blocks(
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
  v_blocks jsonb;
  v_count integer;
  v_now timestamptz := clock_timestamp();
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
    select 1 from public.player_world_state as state
     where state.world_id = p_world_id and state.player_id = v_actor
  ) then
    raise exception 'player is not bootstrapped in this world' using errcode = '42501';
  end if;

  -- LIMIT + 1 is intentional: dense regions fail explicitly instead of
  -- returning a partial world that would make collision decisions unsafe.
  with nearby as materialized (
    select block as value
      from public.blocks as block
     where block.world_id = p_world_id
       and block.zone <> 'mission'
       and block.chunk_x between p_chunk_x - p_radius and p_chunk_x + p_radius
       and block.chunk_y between p_chunk_y - p_vertical_radius and p_chunk_y + p_vertical_radius
       and block.chunk_z between p_chunk_z - p_radius and p_chunk_z + p_radius
     order by block.created_at, block.id
     limit 8193
  )
  select count(*)::integer,
         coalesce(
           jsonb_agg(
             private.block_public_json(nearby.value)
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
    'blocks', v_blocks,
    'block_count', v_count,
    'block_limit', 8192,
    'server_now', v_now
  );
end;
$$;

revoke execute on function public.get_nearby_blocks(
  uuid, integer, integer, integer, integer, integer
) from public, anon;
grant execute on function public.get_nearby_blocks(
  uuid, integer, integer, integer, integer, integer
) to authenticated;

comment on function public.get_nearby_blocks(
  uuid, integer, integer, integer, integer, integer
) is
  'Reads bounded 16x16x16 chunks around an anonymous player. More than 8192 rows fails without a partial response.';

commit;
