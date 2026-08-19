begin;

-- Existing environments have already recorded 202608110004 as applied, so
-- changing that seed migration cannot rename their persisted template row.
update public.mission_templates
   set name = '별빛 관문'
 where id = '60000000-0000-4000-8000-000000000001'
   and template_key = 'starlight-gate'
   and version = 1
   and name = '루멘문';

commit;
