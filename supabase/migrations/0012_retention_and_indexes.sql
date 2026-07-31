-- =============================================================================
-- OpeniWatch 0012 — data retention framework and query indexes
-- =============================================================================
-- Retention is implemented as: settings -> dry-run report -> purge -> audit,
-- with legal hold as a hard exclusion. The scheduled job is DISABLED by default
-- and must be switched on deliberately, per program.
--
-- Also adds the indexes the paginated, server-side-filtered read paths need.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Retention settings
-- -----------------------------------------------------------------------------

alter table public.programs
  add column if not exists alert_retention_days integer
    check (alert_retention_days is null or alert_retention_days > 0);

alter table public.programs
  add column if not exists audit_retention_days integer
    check (audit_retention_days is null or audit_retention_days > 0);

alter table public.programs
  add column if not exists retention_enabled boolean not null default false;

comment on column public.programs.retention_enabled is
  'Master switch for automated purging in this program. OFF by default: deleting operational evidence must be a deliberate act, never a default.';
comment on column public.programs.alert_retention_days is
  'How long validated alerts are kept. Null inherits signal_retention_days.';
comment on column public.programs.audit_retention_days is
  'How long audit events are kept. Null means keep indefinitely — the recommended setting for a security operations record.';

-- -----------------------------------------------------------------------------
-- Legal / administrative hold
-- -----------------------------------------------------------------------------
-- A hold blocks purging regardless of any retention setting. Holds are recorded
-- against a specific record so a purge can always explain what it skipped.
-- -----------------------------------------------------------------------------

create table if not exists public.retention_holds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  entity_type text not null check (entity_type in ('signal', 'alert', 'candidate_alert', 'program')),
  entity_id uuid not null,
  reason text not null,
  placed_by uuid references auth.users (id) on delete set null,
  placed_at timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.retention_holds is
  'Legal or administrative holds. A record under an active hold is never purged, whatever the retention policy says.';

create index if not exists retention_holds_entity_idx
  on public.retention_holds (entity_type, entity_id) where released_at is null;

create table if not exists public.retention_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  program_id uuid references public.programs (id) on delete set null,
  -- A dry run reports what would be deleted and deletes nothing.
  is_dry_run boolean not null default true,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  signals_considered integer not null default 0,
  signals_purged integer not null default 0,
  alerts_considered integer not null default 0,
  alerts_purged integer not null default 0,
  held_back integer not null default 0,
  detail jsonb not null default '{}'::jsonb,
  triggered_by uuid references auth.users (id) on delete set null
);

comment on table public.retention_runs is
  'One row per retention evaluation, dry run or real. The record of what was removed and what was held back.';

-- -----------------------------------------------------------------------------
-- Retention evaluation
-- -----------------------------------------------------------------------------
-- `openiwatch.retention_report()` is read-only and safe to call at any time.
-- `openiwatch.run_retention()` performs the purge and always writes a run row
-- and an audit event. Both respect holds.
-- -----------------------------------------------------------------------------

create or replace function openiwatch.retention_report(p_program uuid)
returns table (
  entity text,
  eligible bigint,
  held_back bigint,
  cutoff timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_signal_days integer;
  v_alert_days integer;
  v_org uuid;
begin
  select organization_id,
         coalesce(signal_retention_days, 365),
         coalesce(alert_retention_days, signal_retention_days, 365)
    into v_org, v_signal_days, v_alert_days
    from public.programs where id = p_program;

  if v_org is null then
    raise exception 'Unknown program %', p_program;
  end if;

  return query
  select 'signal'::text,
         count(*) filter (where h.id is null),
         count(*) filter (where h.id is not null),
         (now() - make_interval(days => v_signal_days))
    from public.signals s
    left join public.retention_holds h
      on h.entity_type = 'signal' and h.entity_id = s.id and h.released_at is null
   where s.program_id = p_program
     and s.ingested_at < now() - make_interval(days => v_signal_days)
     -- A signal behind a validated alert is operational evidence: never purge
     -- it on the signal schedule.
     and not exists (select 1 from public.alerts a where a.signal_id = s.id);

  return query
  select 'alert'::text,
         count(*) filter (where h.id is null),
         count(*) filter (where h.id is not null),
         (now() - make_interval(days => v_alert_days))
    from public.alerts a
    left join public.retention_holds h
      on h.entity_type = 'alert' and h.entity_id = a.id and h.released_at is null
   where a.program_id = p_program
     and a.validated_at < now() - make_interval(days => v_alert_days)
     -- Only finished incidents are eligible.
     and a.status = 'closed';
end;
$$;

comment on function openiwatch.retention_report is
  'Read-only. Reports what a purge would remove for a program, and how much is held back. Deletes nothing.';

create or replace function openiwatch.run_retention(
  p_program uuid,
  p_dry_run boolean default true,
  p_actor uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_enabled boolean;
  v_signal_days integer;
  v_alert_days integer;
  v_run uuid;
  v_signals_considered bigint := 0;
  v_alerts_considered bigint := 0;
  v_held bigint := 0;
  v_signals_purged bigint := 0;
  v_alerts_purged bigint := 0;
begin
  select organization_id, retention_enabled,
         coalesce(signal_retention_days, 365),
         coalesce(alert_retention_days, signal_retention_days, 365)
    into v_org, v_enabled, v_signal_days, v_alert_days
    from public.programs where id = p_program;

  if v_org is null then
    raise exception 'Unknown program %', p_program;
  end if;

  -- A real purge requires the program switch to be on. A dry run is always
  -- allowed, because seeing what would happen must never need the safety off.
  if not p_dry_run and not v_enabled then
    raise exception
      'Retention is not enabled for this program. Enable programs.retention_enabled before running a real purge.';
  end if;

  select coalesce(sum(eligible), 0), coalesce(sum(held_back), 0)
    into v_signals_considered, v_held
    from openiwatch.retention_report(p_program) where entity = 'signal';

  select coalesce(sum(eligible), 0)
    into v_alerts_considered
    from openiwatch.retention_report(p_program) where entity = 'alert';

  insert into public.retention_runs (
    organization_id, program_id, is_dry_run, signals_considered,
    alerts_considered, held_back, triggered_by
  ) values (
    v_org, p_program, p_dry_run, v_signals_considered,
    v_alerts_considered, v_held, p_actor
  ) returning id into v_run;

  if not p_dry_run then
    with purged as (
      delete from public.signals s
       where s.program_id = p_program
         and s.ingested_at < now() - make_interval(days => v_signal_days)
         and not exists (select 1 from public.alerts a where a.signal_id = s.id)
         and not exists (
           select 1 from public.retention_holds h
            where h.entity_type = 'signal' and h.entity_id = s.id and h.released_at is null
         )
      returning 1
    )
    select count(*) into v_signals_purged from purged;

    with purged as (
      delete from public.alerts a
       where a.program_id = p_program
         and a.validated_at < now() - make_interval(days => v_alert_days)
         and a.status = 'closed'
         and not exists (
           select 1 from public.retention_holds h
            where h.entity_type = 'alert' and h.entity_id = a.id and h.released_at is null
         )
      returning 1
    )
    select count(*) into v_alerts_purged from purged;
  end if;

  update public.retention_runs
     set finished_at = now(),
         signals_purged = v_signals_purged,
         alerts_purged = v_alerts_purged
   where id = v_run;

  -- The purge itself is audited. Audit events are never purged by this
  -- function: destroying the record of a deletion defeats the point.
  insert into public.audit_events (
    organization_id, actor_user_id, actor_role, action, entity_type, entity_id, detail
  ) values (
    v_org, p_actor, case when p_actor is null then 'system' else 'program_admin' end,
    case when p_dry_run then 'retention.dry_run' else 'retention.purged' end,
    'program', p_program,
    jsonb_build_object(
      'runId', v_run,
      'signalsConsidered', v_signals_considered,
      'signalsPurged', v_signals_purged,
      'alertsConsidered', v_alerts_considered,
      'alertsPurged', v_alerts_purged,
      'heldBack', v_held,
      'signalRetentionDays', v_signal_days,
      'alertRetentionDays', v_alert_days
    )
  );

  return v_run;
end;
$$;

comment on function openiwatch.run_retention is
  'Runs retention for a program. Dry run by default. A real purge additionally requires programs.retention_enabled. Always writes a retention_runs row and an audit event, and never purges audit events.';

-- -----------------------------------------------------------------------------
-- RLS for the retention tables
-- -----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['retention_holds', 'retention_runs']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end
$$;

drop policy if exists retention_holds_select on public.retention_holds;
create policy retention_holds_select on public.retention_holds
  for select to authenticated
  using (openiwatch.is_org_member(organization_id));

drop policy if exists retention_holds_admin on public.retention_holds;
create policy retention_holds_admin on public.retention_holds
  for all to authenticated
  using (openiwatch.can_administer(organization_id))
  with check (openiwatch.can_administer(organization_id));

drop policy if exists retention_runs_select on public.retention_runs;
create policy retention_runs_select on public.retention_runs
  for select to authenticated
  using (openiwatch.is_org_member(organization_id));

-- Runs are written by the purge function (service role) only. No client insert
-- policy exists, so a retention run cannot be forged.

grant select, insert, update, delete on public.retention_holds to authenticated, service_role;
grant select on public.retention_runs to authenticated;
grant select, insert, update on public.retention_runs to service_role;

-- Triggers for the audited columns on retention_holds.
drop trigger if exists retention_holds_touch on public.retention_holds;
create trigger retention_holds_touch before update on public.retention_holds
  for each row execute function openiwatch.touch_row();
drop trigger if exists retention_holds_stamp on public.retention_holds;
create trigger retention_holds_stamp before insert on public.retention_holds
  for each row execute function openiwatch.stamp_row();

-- =============================================================================
-- Indexes for paginated, server-side-filtered reads
-- =============================================================================
-- The Phase 1 provider loaded whole tables. These support the keyset/offset
-- pagination and server-side filters introduced alongside this migration.
-- =============================================================================

-- Alert feed: filtered by program, then severity/status/location, ordered by
-- validated_at descending.
create index if not exists alerts_program_validated_idx
  on public.alerts (program_id, validated_at desc);

create index if not exists alerts_program_status_validated_idx
  on public.alerts (program_id, status, validated_at desc);

create index if not exists alerts_program_severity_validated_idx
  on public.alerts (program_id, severity, validated_at desc);

-- "Unacknowledged and still active" — the operations overview counter and the
-- automatic escalation sweep both run this.
create index if not exists alerts_unacknowledged_idx
  on public.alerts (program_id, severity, first_notified_at)
  where acknowledged_at is null and status not in ('resolved', 'closed');

-- Analyst queue: pending candidates by priority.
create index if not exists candidate_alerts_pending_idx
  on public.candidate_alerts (program_id, automated_priority_score desc, created_at desc)
  where status in ('pending_review', 'under_review');

-- Signal lookups by program and recency, and the duplicate-detection window.
create index if not exists signals_program_ingested_idx
  on public.signals (program_id, ingested_at desc);

-- Notification inbox for one user.
create index if not exists notification_deliveries_user_unread_idx
  on public.notification_deliveries (user_id, created_at desc)
  where read_at is null;

-- Audit trail for one entity, and the organization activity feed.
create index if not exists audit_events_actor_idx
  on public.audit_events (organization_id, actor_user_id, occurred_at desc);
