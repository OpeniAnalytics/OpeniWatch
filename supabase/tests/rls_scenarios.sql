-- =============================================================================
-- Row Level Security scenario tests
-- =============================================================================
-- Executes the security rules that matter operationally, as each role, against
-- a real PostgreSQL instance. Every check either prints PASS or raises.
--
-- Run against a database with all migrations applied:
--
--   psql -f supabase/tests/rls_scenarios.sql -v ON_ERROR_STOP=1
--
-- On a local stack:  supabase db reset && psql "$(supabase status -o env | ...)" -f ...
-- On a shim:         see scripts/test-rls.sh
--
-- The `authenticated` role is assumed, with auth.uid() driven by the
-- `request.jwt.claim.sub` setting — the same mechanism Supabase uses.
-- =============================================================================

\set ON_ERROR_STOP on
-- NOTICE shows each PASS; WARNING shows each FAIL.
set client_min_messages = notice;

-- -----------------------------------------------------------------------------
-- Fixtures
-- -----------------------------------------------------------------------------

create temporary table if not exists rls_results (
  check_name text,
  passed boolean,
  detail text
);

do $$
declare
  v_org uuid := 'a0000000-0000-4000-8000-000000000001';
  v_program uuid := 'a0000000-0000-4000-8000-000000000002';
  v_users jsonb := jsonb_build_object(
    'analyst',      '10000000-0000-4000-8000-000000000003',
    'soc_manager',  '10000000-0000-4000-8000-000000000004',
    'soc_operator', '10000000-0000-4000-8000-000000000005',
    'viewer',       '10000000-0000-4000-8000-000000000006',
    'program_admin','10000000-0000-4000-8000-000000000002',
    'outsider',     '10000000-0000-4000-8000-0000000000ff',
    -- A dedicated target for the role-mutation checks, so changing a role does
    -- not alter the permissions of a user later checks depend on.
    'role_target',  '10000000-0000-4000-8000-0000000000fe'
  );
  v_role text;
  v_id uuid;
begin
  -- Reset roles for the fixture users so the script is deterministic on re-run:
  -- an earlier run's role change must not leak into this one.
  delete from public.user_roles
   where user_id in (select (value #>> '{}')::uuid from jsonb_each(v_users));

  for v_role, v_id in select key, value #>> '{}' from jsonb_each(v_users)
  loop
    insert into auth.users (id, email) values (v_id, v_role || '@openiwatch.example')
      on conflict (id) do nothing;

    insert into public.profiles (user_id, email, full_name)
      values (v_id, v_role || '@openiwatch.example', initcap(replace(v_role, '_', ' ')))
      on conflict (user_id) do nothing;

    -- The outsider gets no membership and no role: they must see nothing.
    if v_role <> 'outsider' then
      insert into public.organization_memberships (organization_id, user_id, is_primary)
        values (v_org, v_id, true) on conflict do nothing;
      insert into public.program_memberships (program_id, user_id)
        values (v_program, v_id) on conflict do nothing;
      insert into public.user_roles (user_id, role, organization_id)
        values (
          v_id,
          (case when v_role = 'role_target' then 'viewer' else v_role end)::public.app_role,
          v_org
        ) on conflict do nothing;
    end if;
  end loop;
end
$$;

-- A signal, a candidate and an alert to act on.
insert into public.signals (
  id, organization_id, program_id, source_platform, source_record_id,
  original_text, published_at, collection_method, provenance, content_hash
) values (
  '90000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
  'Public web source', 'rls-test-1',
  'Man with a gun in the parking lot at Costco #1487 in Stafford.',
  now() - interval '5 minutes', 'simulator', 'RLS scenario fixture', 'rls-test-hash-1'
) on conflict do nothing;

insert into public.candidate_alerts (
  id, organization_id, program_id, signal_id, location_id, status,
  automated_category_key, automated_severity, automated_priority_score,
  automated_score, automated_explanation, incident_location_confidence
) values (
  '91000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
  '90000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
  'pending_review', 'weapon_or_firearm', 'critical', 84,
  '{"priorityScore":84}'::jsonb, 'Fixture explanation.', 92
) on conflict do nothing;

insert into public.alerts (
  id, organization_id, program_id, candidate_alert_id, signal_id, location_id,
  title, summary, category_key, severity, status, priority_score,
  incident_location_confidence, published_at, detected_at, validated_by
) values (
  '92000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
  '91000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
  'Weapon or firearm — Costco #1487', 'Fixture alert.', 'weapon_or_firearm',
  'critical', 'open', 84, 92, now() - interval '5 minutes', now() - interval '4 minutes',
  '10000000-0000-4000-8000-000000000003'
) on conflict do nothing;

-- Reset the fixture records to a known state so the script is re-runnable.
update public.candidate_alerts
   set status = 'pending_review'
 where id = '91000000-0000-4000-8000-000000000001';

update public.alerts
   set status = 'open', acknowledged_at = null, acknowledged_by = null
 where id = '92000000-0000-4000-8000-000000000001';

delete from public.alert_acknowledgments
 where alert_id = '92000000-0000-4000-8000-000000000001';

update public.scoring_thresholds
   set critical_min = 80
 where organization_id = 'a0000000-0000-4000-8000-000000000001';

-- -----------------------------------------------------------------------------
-- Harness
-- -----------------------------------------------------------------------------
-- Runs `sql` as `user_id` under the `authenticated` role and records whether it
-- was permitted, then compares that against what the rule requires.
-- -----------------------------------------------------------------------------

create or replace function pg_temp.expect(
  p_name text,
  p_user uuid,
  p_sql text,
  p_should_succeed boolean
) returns void
language plpgsql
as $$
declare
  v_succeeded boolean := true;
  v_detail text := '';
  v_rows bigint := 0;
begin
  begin
    execute format('set local role authenticated');
    execute format('set local request.jwt.claim.sub = %L', p_user::text);
    execute p_sql;
    -- EXECUTE does not set FOUND, so read the row count explicitly. A write
    -- blocked by a WITH CHECK clause raises; a write filtered by a USING
    -- clause silently affects zero rows, and both count as "not permitted".
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      v_succeeded := false;
      v_detail := 'no rows affected (filtered by a USING clause)';
    end if;
  exception
    when insufficient_privilege or check_violation then
      v_succeeded := false;
      v_detail := 'blocked: ' || sqlerrm;
    when others then
      v_succeeded := false;
      v_detail := 'error: ' || sqlerrm;
  end;

  reset role;

  insert into rls_results (check_name, passed, detail)
  values (p_name, v_succeeded = p_should_succeed, v_detail);

  if v_succeeded <> p_should_succeed then
    raise warning 'FAIL % — expected %, got % (%)',
      p_name,
      case when p_should_succeed then 'allowed' else 'blocked' end,
      case when v_succeeded then 'allowed' else 'blocked' end,
      v_detail;
  else
    raise notice 'PASS %', p_name;
  end if;
end
$$;

-- Reads a count as `user_id` and compares it. Used for visibility checks, where
-- RLS filters rows rather than raising.
create or replace function pg_temp.expect_count(
  p_name text,
  p_user uuid,
  p_table text,
  p_expected bigint
) returns void
language plpgsql
as $$
declare
  v_count bigint;
begin
  execute 'set local role authenticated';
  execute format('set local request.jwt.claim.sub = %L', p_user::text);
  begin
    execute format('select count(*) from %s', p_table) into v_count;
  exception when insufficient_privilege then
    -- No table privilege is a stronger outcome than an empty result: the role
    -- cannot read the table at all. Both satisfy a "sees no rows" expectation.
    v_count := 0;
  end;
  reset role;

  insert into rls_results (check_name, passed, detail)
  values (p_name, v_count = p_expected, format('saw %s rows, expected %s', v_count, p_expected));

  if v_count <> p_expected then
    raise warning 'FAIL % — saw % rows, expected %', p_name, v_count, p_expected;
  else
    raise notice 'PASS %', p_name;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Scenarios
-- -----------------------------------------------------------------------------

do $$
declare
  analyst uuid := '10000000-0000-4000-8000-000000000003';
  soc_manager uuid := '10000000-0000-4000-8000-000000000004';
  soc_operator uuid := '10000000-0000-4000-8000-000000000005';
  viewer uuid := '10000000-0000-4000-8000-000000000006';
  program_admin uuid := '10000000-0000-4000-8000-000000000002';
  outsider uuid := '10000000-0000-4000-8000-0000000000ff';
  -- Role mutations target this user so they cannot disturb the other checks.
  role_target uuid := '10000000-0000-4000-8000-0000000000fe';
begin
  -- Validation is restricted to analysts and program administrators.
  perform pg_temp.expect(
    'analyst may triage a candidate', analyst,
    $q$update public.candidate_alerts set status = 'under_review'
        where id = '91000000-0000-4000-8000-000000000001'$q$, true);

  perform pg_temp.expect(
    'soc_manager may NOT validate a candidate', soc_manager,
    $q$update public.candidate_alerts set status = 'validated'
        where id = '91000000-0000-4000-8000-000000000001'$q$, false);

  perform pg_temp.expect(
    'soc_operator may NOT validate a candidate', soc_operator,
    $q$update public.candidate_alerts set status = 'validated'
        where id = '91000000-0000-4000-8000-000000000001'$q$, false);

  perform pg_temp.expect(
    'viewer may NOT validate a candidate', viewer,
    $q$update public.candidate_alerts set status = 'validated'
        where id = '91000000-0000-4000-8000-000000000001'$q$, false);

  -- SOC operations.
  perform pg_temp.expect(
    'soc_manager may acknowledge an alert', soc_manager,
    $q$update public.alerts set status = 'acknowledged', acknowledged_at = now(),
        acknowledged_by = '10000000-0000-4000-8000-000000000004'
        where id = '92000000-0000-4000-8000-000000000001'$q$, true);

  perform pg_temp.expect(
    'viewer may NOT acknowledge an alert', viewer,
    $q$update public.alerts set status = 'acknowledged'
        where id = '92000000-0000-4000-8000-000000000001'$q$, false);

  perform pg_temp.expect(
    'viewer may NOT record an acknowledgment row', viewer,
    $q$insert into public.alert_acknowledgments (alert_id, acknowledged_by)
        values ('92000000-0000-4000-8000-000000000001',
                '10000000-0000-4000-8000-000000000006')$q$, false);

  -- Acknowledgments are attributable: you may only record your own.
  perform pg_temp.expect(
    'soc_operator may NOT acknowledge as another user', soc_operator,
    $q$insert into public.alert_acknowledgments (alert_id, acknowledged_by)
        values ('92000000-0000-4000-8000-000000000001',
                '10000000-0000-4000-8000-000000000004')$q$, false);

  -- Role changes.
  perform pg_temp.expect(
    'analyst may NOT change roles', analyst,
    $q$update public.user_roles set role = 'program_admin'
        where user_id = '10000000-0000-4000-8000-0000000000fe'$q$, false);

  perform pg_temp.expect(
    'soc_manager may NOT change roles', soc_manager,
    $q$update public.user_roles set role = 'program_admin'
        where user_id = '10000000-0000-4000-8000-0000000000fe'$q$, false);

  perform pg_temp.expect(
    'program_admin may change a role', program_admin,
    $q$update public.user_roles set role = 'analyst'
        where user_id = '10000000-0000-4000-8000-0000000000fe'$q$, true);

  perform pg_temp.expect(
    'program_admin may NOT mint a super administrator', program_admin,
    $q$insert into public.user_roles (user_id, role, organization_id)
        values ('10000000-0000-4000-8000-0000000000fe', 'super_admin',
                'a0000000-0000-4000-8000-000000000001')$q$, false);

  perform pg_temp.expect(
    'viewer may NOT grant themselves a role', viewer,
    $q$insert into public.user_roles (user_id, role, organization_id)
        values ('10000000-0000-4000-8000-000000000006', 'program_admin',
                'a0000000-0000-4000-8000-000000000001')$q$, false);

  -- Administration settings.
  perform pg_temp.expect(
    'soc_manager may NOT change scoring thresholds', soc_manager,
    $q$update public.scoring_thresholds set critical_min = 50
        where organization_id = 'a0000000-0000-4000-8000-000000000001'$q$, false);

  perform pg_temp.expect(
    'program_admin may change scoring thresholds', program_admin,
    $q$update public.scoring_thresholds set critical_min = 81
        where organization_id = 'a0000000-0000-4000-8000-000000000001'$q$, true);

  perform pg_temp.expect(
    'analyst may NOT deactivate a location', analyst,
    $q$update public.locations set is_active = false
        where id = 'b0000000-0000-4000-8000-000000000001'$q$, false);

  -- Evidence immutability.
  perform pg_temp.expect(
    'analyst may NOT edit a signal', analyst,
    $q$update public.signals set original_text = 'tampered'
        where id = '90000000-0000-4000-8000-000000000001'$q$, false);

  perform pg_temp.expect(
    'program_admin may NOT edit a signal', program_admin,
    $q$update public.signals set original_text = 'tampered'
        where id = '90000000-0000-4000-8000-000000000001'$q$, false);

  -- Audit trail is append-only.
  perform pg_temp.expect(
    'program_admin may NOT update an audit event', program_admin,
    $q$update public.audit_events set action = 'tampered'$q$, false);

  perform pg_temp.expect(
    'program_admin may NOT delete an audit event', program_admin,
    $q$delete from public.audit_events$q$, false);

  -- Cross-tenant isolation.
  perform pg_temp.expect_count('outsider sees no alerts', outsider, 'public.alerts', 0);
  perform pg_temp.expect_count('outsider sees no signals', outsider, 'public.signals', 0);
  perform pg_temp.expect_count('outsider sees no locations', outsider, 'public.locations', 0);
  perform pg_temp.expect_count('outsider sees no candidates', outsider, 'public.candidate_alerts', 0);

  -- A program member does see the program's data.
  perform pg_temp.expect_count('analyst sees the seeded locations', analyst, 'public.locations', 7);
  perform pg_temp.expect_count('viewer sees the fixture alert', viewer, 'public.alerts', 1);

  perform pg_temp.expect(
    'outsider may NOT insert a candidate', outsider,
    $q$insert into public.candidate_alerts (
         organization_id, program_id, signal_id, status,
         automated_category_key, automated_severity, automated_priority_score,
         automated_score, automated_explanation)
       values ('a0000000-0000-4000-8000-000000000001',
               'a0000000-0000-4000-8000-000000000002',
               '90000000-0000-4000-8000-000000000001', 'pending_review',
               'weapon_or_firearm', 'critical', 90, '{}'::jsonb, 'x')$q$, false);

  -- Ingest rate limits: RLS on, no policies, so no application role may read.
  perform pg_temp.expect_count(
    'program_admin sees no ingest rate limit rows', program_admin,
    'public.ingest_rate_limits', 0);
end
$$;

-- -----------------------------------------------------------------------------
-- Result
-- -----------------------------------------------------------------------------

select
  count(*) filter (where passed) as passed,
  count(*) filter (where not passed) as failed,
  count(*) as total
from rls_results;

select check_name, detail from rls_results where not passed;

do $$
declare
  v_failed integer;
begin
  select count(*) into v_failed from rls_results where not passed;
  if v_failed > 0 then
    raise exception '% RLS scenario check(s) failed', v_failed;
  end if;
  raise notice 'All RLS scenario checks passed.';
end
$$;
