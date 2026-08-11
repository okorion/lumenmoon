insert into public.worlds (
  id,
  slug,
  title,
  enabled,
  starter_slot_capacity
)
values (
  '00000000-0000-4000-8000-000000000001'::uuid,
  'mvp-shared-1',
  '하늘탑 공동 월드',
  true,
  64
)
on conflict (id) do update
set slug = excluded.slug,
    title = excluded.title,
    enabled = excluded.enabled,
    starter_slot_capacity = excluded.starter_slot_capacity;

insert into public.mission_instances (
  world_id,
  template_id,
  layer,
  origin_x,
  origin_y,
  origin_z,
  rotation,
  palette_seed,
  status,
  filled_slots,
  total_slots,
  stage_percent
)
values (
  '00000000-0000-4000-8000-000000000001'::uuid,
  '60000000-0000-4000-8000-000000000001'::uuid,
  1,
  0,
  1,
  0,
  0,
  0,
  'active',
  0,
  24,
  0
)
on conflict (world_id, layer) do nothing;

-- Starter platforms, paths, and guides are deterministic client-rendered
-- geometry. Their coordinates remain server-protected by position_zone(); they
-- are not duplicated as mutable block rows.
