-- =============================================================================
-- Retention framework scenario tests
-- =============================================================================
-- Proves the retention rules against real PostgreSQL: dry runs are read-only,
-- a real purge refuses without the program switch, holds block deletion, and
-- audit events are never purged.
--
--   psql -f supabase/tests/retention_scenarios.sql -v ON_ERROR_STOP=1
-- =============================================================================

\set ON_ERROR_STOP on
set client_min_messages = notice;

create temporary table if not exists retention_results (
  check_name text, passed boolean, detail text
);

create or replace function pg_temp.check(p_name text, p_passed boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  insert into retention_results values (p_name, p_passed, p_detail);
  if p_passed then raise notice 'PASS %', p_name;
  else raise warning 'FAIL % — %', p_name, p_detail; end if;
end $$;

do $$
declare
  v_org uuid := 'a0000000-0000-4000-8000-000000000001';
  v_program uuid := 'a0000000-0000-4000-8000-000000000002';
  v_old_signal uuid;
  v_held_signal uuid;
  v_before bigint;
  v_after bigint;
  v_run uuid;
  v_audit_before bigint;
  v_audit_after bigint;
  v_eligible bigint;
  v_held bigint;
begin
  -- Two signals well past any retention window; one will be placed on hold.
  insert into public.signals (
    organization_id, program_id, source_platform, source_record_id, original_text,
    published_at, ingested_at, collection_method, provenance, content_hash
  ) values
    (v_org, v_program, 'Public web source', 'retention-test-old', 'Old retention fixture.',
     now() - interval '800 days', now() - interval '800 days', 'simulator', 'fixture', 'ret-hash-1'),
    (v_org, v_program, 'Public web source', 'retention-test-held', 'Held retention fixture.',
     now() - interval '800 days', now() - interval '800 days', 'simulator', 'fixture', 'ret-hash-2')
  on conflict (organization_id, source_platform, source_record_id) do nothing;

  select id into v_old_signal from public.signals where source_record_id = 'retention-test-old';
  select id into v_held_signal from public.signals where source_record_id = 'retention-test-held';

  insert into public.retention_holds (organization_id, entity_type, entity_id, reason)
  values (v_org, 'signal', v_held_signal, 'Retention scenario fixture — legal hold')
  on conflict do nothing;

  -- 1. The report is read-only and counts holds separately.
  select eligible, held_back into v_eligible, v_held
    from openiwatch.retention_report(v_program) where entity = 'signal';
  perform pg_temp.check(
    'retention_report counts an eligible signal',
    v_eligible >= 1, format('eligible=%s', v_eligible));
  perform pg_temp.check(
    'retention_report counts a held signal separately',
    v_held >= 1, format('held_back=%s', v_held));

  select count(*) into v_before from public.signals where program_id = v_program;
  perform openiwatch.retention_report(v_program);
  select count(*) into v_after from public.signals where program_id = v_program;
  perform pg_temp.check('retention_report deletes nothing', v_before = v_after,
    format('%s -> %s', v_before, v_after));

  -- 2. A real purge refuses while the program switch is off.
  update public.programs set retention_enabled = false where id = v_program;
  begin
    perform openiwatch.run_retention(v_program, false, null);
    perform pg_temp.check('real purge refuses when retention is disabled', false, 'it ran');
  exception when others then
    perform pg_temp.check('real purge refuses when retention is disabled', true, sqlerrm);
  end;

  -- 3. A dry run is allowed even with the switch off, and still deletes nothing.
  select count(*) into v_before from public.signals where program_id = v_program;
  v_run := openiwatch.run_retention(v_program, true, null);
  select count(*) into v_after from public.signals where program_id = v_program;
  perform pg_temp.check('dry run is allowed with the switch off', v_run is not null);
  perform pg_temp.check('dry run deletes nothing', v_before = v_after,
    format('%s -> %s', v_before, v_after));
  perform pg_temp.check('dry run is recorded',
    exists (select 1 from public.retention_runs where id = v_run and is_dry_run));

  -- 4. A real purge removes the eligible signal but not the held one, and never
  --    touches audit events.
  select count(*) into v_audit_before from public.audit_events;
  update public.programs set retention_enabled = true where id = v_program;
  v_run := openiwatch.run_retention(v_program, false, null);
  select count(*) into v_audit_after from public.audit_events;

  perform pg_temp.check('real purge removes the eligible signal',
    not exists (select 1 from public.signals where id = v_old_signal));
  perform pg_temp.check('a held signal survives the purge',
    exists (select 1 from public.signals where id = v_held_signal));
  perform pg_temp.check('audit events are never purged',
    v_audit_after > v_audit_before,
    format('%s -> %s (the purge itself adds one)', v_audit_before, v_audit_after));
  perform pg_temp.check('the purge writes an audit event',
    exists (select 1 from public.audit_events
             where action = 'retention.purged' and detail->>'runId' = v_run::text));
  perform pg_temp.check('the run records what was held back',
    exists (select 1 from public.retention_runs where id = v_run and held_back >= 1));

  -- Restore: staging must not be left with retention switched on.
  update public.programs set retention_enabled = false where id = v_program;
  delete from public.retention_holds where entity_id = v_held_signal;
  delete from public.signals where source_record_id like 'retention-test-%';
end
$$;

select count(*) filter (where passed) as passed,
       count(*) filter (where not passed) as failed,
       count(*) as total
  from retention_results;

do $$
declare v_failed integer;
begin
  select count(*) into v_failed from retention_results where not passed;
  if v_failed > 0 then raise exception '% retention check(s) failed', v_failed; end if;
  raise notice 'All retention scenario checks passed.';
end $$;
