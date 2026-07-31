-- =============================================================================
-- Staging performance dataset
-- =============================================================================
-- Generates the volume Step 14 calls for, then times the queries the paginated
-- read paths issue. Run against a database with all migrations applied:
--
--   psql -f scripts/perf-dataset.sql
--
-- Everything it creates is tagged `perf-` in its source_record_id, so it can be
-- identified and removed. It is NOT test data to leave in a real project.
-- =============================================================================

\set ON_ERROR_STOP on
set client_min_messages = warning;

\timing off

-- -----------------------------------------------------------------------------
-- Volume: 50 locations, 100 users, 10k signals, 1k candidates, 250 alerts
-- -----------------------------------------------------------------------------

do $$
declare
  v_org uuid := 'a0000000-0000-4000-8000-000000000001';
  v_program uuid := 'a0000000-0000-4000-8000-000000000002';
  v_analyst uuid := '10000000-0000-4000-8000-000000000003';
  v_existing_locations integer;
begin
  -- The two fixed actors the generated alerts attribute work to. Created here
  -- so this script runs against a database that has only had the migrations
  -- applied, with no user seeding.
  insert into auth.users (id, email) values
    (v_analyst, 'perf-analyst@openiwatch.example'),
    ('10000000-0000-4000-8000-000000000004', 'perf-soc-manager@openiwatch.example')
  on conflict (id) do nothing;

  insert into public.profiles (user_id, email, full_name) values
    (v_analyst, 'perf-analyst@openiwatch.example', 'Perf Analyst'),
    ('10000000-0000-4000-8000-000000000004', 'perf-soc-manager@openiwatch.example', 'Perf SOC Manager')
  on conflict (user_id) do nothing;

  -- Users
  insert into auth.users (id, email)
  select gen_random_uuid(), 'perf-user-' || i || '@openiwatch.example'
    from generate_series(1, 100) i
  on conflict do nothing;

  insert into public.profiles (user_id, email, full_name)
  select u.id, u.email, 'Perf User'
    from auth.users u
   where u.email like 'perf-user-%'
  on conflict (user_id) do nothing;

  insert into public.organization_memberships (organization_id, user_id)
  select v_org, u.id from auth.users u where u.email like 'perf-user-%'
  on conflict do nothing;

  insert into public.program_memberships (program_id, user_id)
  select v_program, u.id from auth.users u where u.email like 'perf-user-%'
  on conflict do nothing;

  insert into public.user_roles (user_id, role, organization_id)
  select u.id, 'soc_operator', v_org from auth.users u where u.email like 'perf-user-%'
  on conflict do nothing;

  -- Locations, up to 50 in total including the 7 pilot sites.
  select count(*) into v_existing_locations from public.locations where program_id = v_program;

  insert into public.locations (
    organization_id, program_id, facility_number, official_name, address_line1,
    city, state, postal_code, latitude, longitude, time_zone
  )
  select v_org, v_program, 'PERF' || i, 'Perf Location ' || i, i || ' Test Road',
         'Testville', 'TX', '77000', 29.6 + (i::numeric / 1000), -95.5 - (i::numeric / 1000),
         'America/Chicago'
    from generate_series(1, greatest(0, 50 - v_existing_locations)) i
  on conflict do nothing;

  raise notice 'Users and locations ready.';
end
$$;

-- Signals: 10,000 spread over the last 90 days.
insert into public.signals (
  organization_id, program_id, source_platform, source_record_id, source_url,
  original_text, published_at, ingested_at, collection_method, provenance, content_hash
)
select
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
  'Public web source',
  'perf-signal-' || i,
  'https://example.com/perf/' || i,
  'Performance dataset signal ' || i ||
    ' describing an incident near a monitored location for load testing purposes.',
  now() - make_interval(mins => i),
  now() - make_interval(mins => i) + interval '2 minutes',
  'simulator',
  'Performance dataset. Not collected content.',
  md5('perf-signal-' || i)
from generate_series(1, 10000) i
on conflict do nothing;

-- Candidates: 1,000 over the first 1,000 signals.
insert into public.candidate_alerts (
  organization_id, program_id, signal_id, location_id, status,
  automated_category_key, automated_severity, automated_priority_score,
  automated_score, automated_explanation, incident_location_confidence
)
select
  s.organization_id, s.program_id, s.id,
  (select id from public.locations where program_id = s.program_id order by facility_number limit 1),
  (array['pending_review','under_review','validated','rejected'])[1 + (row_number() over () % 4)]::public.candidate_status,
  'suspicious_activity',
  (array['critical','high','moderate','informational'])[1 + (row_number() over () % 4)]::public.severity_level,
  40 + (row_number() over () % 60)::integer,
  '{"priorityScore":70}'::jsonb,
  'Performance dataset candidate.',
  50 + (row_number() over () % 40)::integer
from public.signals s
where s.source_record_id like 'perf-signal-%'
order by s.source_record_id
limit 1000
on conflict do nothing;

-- Alerts: 250 from the candidates.
--
-- The lifecycle guard in migration 0006 enforces that a resolved or closed
-- alert has been acknowledged, and that a closed one carries a disposition. The
-- generated mix respects that: a quarter stay open and unacknowledged (which is
-- what the overdue-escalation sweep looks for), and the rest are acknowledged
-- before they progress.
with numbered as (
  select
    c.id as candidate_id, c.organization_id, c.program_id, c.signal_id, c.location_id,
    c.automated_category_key, c.automated_severity, c.automated_priority_score,
    c.incident_location_confidence, s.published_at, s.ingested_at,
    row_number() over (order by s.source_record_id) as rn
  from public.candidate_alerts c
  join public.signals s on s.id = c.signal_id
  where s.source_record_id like 'perf-signal-%'
    and c.location_id is not null
    and not exists (select 1 from public.alerts a where a.candidate_alert_id = c.id)
  limit 250
)
insert into public.alerts (
  organization_id, program_id, candidate_alert_id, signal_id, location_id,
  title, summary, category_key, severity, status, priority_score,
  incident_location_confidence, published_at, detected_at, validated_by,
  first_notified_at, acknowledged_at, acknowledged_by, resolved_at, closed_at, disposition
)
select
  n.organization_id, n.program_id, n.candidate_id, n.signal_id, n.location_id,
  'Perf alert ' || n.rn,
  'Performance dataset alert.',
  n.automated_category_key,
  n.automated_severity,
  (array['open','acknowledged','resolved','closed'])[1 + (n.rn % 4)]::public.alert_status,
  n.automated_priority_score,
  n.incident_location_confidence,
  n.published_at, n.ingested_at,
  '10000000-0000-4000-8000-000000000003',
  n.ingested_at + interval '3 minutes',
  -- Only the `open` quarter is left unacknowledged.
  case when n.rn % 4 = 0 then null else n.ingested_at + interval '6 minutes' end,
  case when n.rn % 4 = 0 then null else '10000000-0000-4000-8000-000000000004'::uuid end,
  case when n.rn % 4 in (2, 3) then n.ingested_at + interval '40 minutes' else null end,
  case when n.rn % 4 = 3 then n.ingested_at + interval '45 minutes' else null end,
  case when n.rn % 4 = 3 then 'resolved'::public.alert_disposition_value else null end
from numbered n
on conflict do nothing;

analyze public.signals;
analyze public.candidate_alerts;
analyze public.alerts;
analyze public.locations;

select 'signals' as table, count(*) from public.signals
union all select 'candidate_alerts', count(*) from public.candidate_alerts
union all select 'alerts', count(*) from public.alerts
union all select 'locations', count(*) from public.locations
union all select 'profiles', count(*) from public.profiles;

-- =============================================================================
-- Timings for the queries the paginated read paths issue
-- =============================================================================

\timing on

\echo ''
\echo '--- Alert feed: first page, filtered by program, ordered by validated_at ---'
explain (analyze, buffers, timing, format text)
select id from public.alerts
 where program_id = 'a0000000-0000-4000-8000-000000000002'
 order by validated_at desc
 limit 50 offset 0;

\echo ''
\echo '--- Alert feed: critical + unacknowledged (the operations overview counter) ---'
explain (analyze, buffers, timing, format text)
select count(*) from public.alerts
 where program_id = 'a0000000-0000-4000-8000-000000000002'
   and severity = 'critical'
   and acknowledged_at is null
   and status not in ('resolved','closed');

\echo ''
\echo '--- Analyst queue: pending candidates by priority ---'
explain (analyze, buffers, timing, format text)
select id from public.candidate_alerts
 where program_id = 'a0000000-0000-4000-8000-000000000002'
   and status in ('pending_review','under_review')
 order by automated_priority_score desc, created_at desc
 limit 50;

\echo ''
\echo '--- Alert detail: one alert by id ---'
explain (analyze, buffers, timing, format text)
select * from public.alerts where id = (select id from public.alerts limit 1);

\echo ''
\echo '--- Reporting: alerts validated in the last 7 days, grouped by severity ---'
explain (analyze, buffers, timing, format text)
select severity, count(*) from public.alerts
 where program_id = 'a0000000-0000-4000-8000-000000000002'
   and validated_at >= now() - interval '7 days'
 group by severity;

\echo ''
\echo '--- Signals: recent page (duplicate-detection window) ---'
explain (analyze, buffers, timing, format text)
select id from public.signals
 where program_id = 'a0000000-0000-4000-8000-000000000002'
 order by ingested_at desc
 limit 50;

\timing off
