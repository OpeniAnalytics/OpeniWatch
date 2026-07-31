-- =============================================================================
-- OpeniWatch 0006 — administration settings (scoring thresholds, escalation
--                   rules) and integrity guards on the alert lifecycle
-- =============================================================================

create table if not exists public.scoring_thresholds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  critical_min integer not null default 80 check (critical_min between 0 and 100),
  high_min integer not null default 60 check (high_min between 0 and 100),
  moderate_min integer not null default 35 check (moderate_min between 0 and 100),
  -- Candidates below this score are auto-suppressed as non-operational.
  auto_suppress_below integer not null default 10 check (auto_suppress_below between 0 and 100),
  -- A candidate is not raised at all below this incident-location confidence.
  minimum_location_confidence integer not null default 25
    check (minimum_location_confidence between 0 and 100),
  scorer_id text not null default 'deterministic-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (organization_id),
  constraint scoring_thresholds_ordered check (critical_min > high_min and high_min > moderate_min)
);

comment on table public.scoring_thresholds is
  'Severity bands applied to the 0-100 priority score. scorer_id selects the scoring implementation, so a hosted model can replace the deterministic scorer without schema changes.';

create table if not exists public.escalation_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  program_id uuid references public.programs (id) on delete cascade,
  severity public.severity_level not null,
  -- Escalate when the alert is still unacknowledged after this many seconds.
  unacknowledged_seconds integer not null check (unacknowledged_seconds > 0),
  escalate_to public.escalation_level not null,
  -- Ordered delivery path, e.g. {in_app, web_push, sms}.
  channel_path public.delivery_channel[] not null default '{in_app}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

-- Expression-based uniqueness: one rule per severity per program, and one
-- organization-wide default rule per severity (program_id is null).
create unique index if not exists escalation_rules_unique_scope
  on public.escalation_rules (
    organization_id,
    coalesce(program_id, '00000000-0000-0000-0000-000000000000'::uuid),
    severity
  );

comment on table public.escalation_rules is
  'Configurable delivery path and unacknowledged-escalation timing per severity. OpeniWatch never notifies emergency services automatically.';

-- -----------------------------------------------------------------------------
-- Lifecycle integrity guards
-- -----------------------------------------------------------------------------
-- These run regardless of which client wrote the row, so an alert can never be
-- resolved without having been acknowledged, and the automated assessment on a
-- candidate can never be rewritten after the fact.
-- -----------------------------------------------------------------------------

create or replace function openiwatch.protect_automated_assessment()
returns trigger
language plpgsql
as $$
begin
  if new.automated_category_key is distinct from old.automated_category_key
     or new.automated_severity is distinct from old.automated_severity
     or new.automated_priority_score is distinct from old.automated_priority_score
     or new.automated_score is distinct from old.automated_score
     or new.automated_explanation is distinct from old.automated_explanation
  then
    raise exception
      'The automated assessment is immutable. Record analyst changes in the analyst_* columns.';
  end if;
  return new;
end;
$$;

drop trigger if exists candidate_alerts_protect_automated on public.candidate_alerts;
create trigger candidate_alerts_protect_automated
  before update on public.candidate_alerts
  for each row execute function openiwatch.protect_automated_assessment();

create or replace function openiwatch.guard_alert_lifecycle()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('resolved', 'closed') and new.acknowledged_at is null then
    raise exception 'An alert must be acknowledged before it can be resolved or closed.';
  end if;

  if new.status = 'closed' and new.disposition is null then
    raise exception 'A final disposition is required before an alert can be closed.';
  end if;

  -- Signal, candidate and validation provenance are fixed at creation.
  if tg_op = 'UPDATE' then
    if new.candidate_alert_id is distinct from old.candidate_alert_id
       or new.signal_id is distinct from old.signal_id
       or new.validated_by is distinct from old.validated_by
       or new.validated_at is distinct from old.validated_at
    then
      raise exception 'Alert provenance (candidate, signal, validation) is immutable.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists alerts_guard_lifecycle on public.alerts;
create trigger alerts_guard_lifecycle
  before insert or update on public.alerts
  for each row execute function openiwatch.guard_alert_lifecycle();

-- -----------------------------------------------------------------------------
-- Ingestion rate limiting
-- -----------------------------------------------------------------------------
-- The ingest Edge Function calls openiwatch.check_ingest_rate() with the
-- caller's bucket key. Counters are kept in the database so the limit survives
-- function cold starts and applies across instances.
-- -----------------------------------------------------------------------------

create table if not exists public.ingest_rate_limits (
  bucket_key text not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (bucket_key, window_start)
);

comment on table public.ingest_rate_limits is
  'Fixed-window counters for the ingest endpoint. Written only by the service role.';

create or replace function openiwatch.check_ingest_rate(
  p_bucket_key text,
  p_limit integer default 120,
  p_window_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window timestamptz;
  v_count integer;
begin
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.ingest_rate_limits (bucket_key, window_start, request_count)
  values (p_bucket_key, v_window, 1)
  on conflict (bucket_key, window_start)
    do update set request_count = public.ingest_rate_limits.request_count + 1
  returning request_count into v_count;

  -- Opportunistic cleanup of expired windows.
  delete from public.ingest_rate_limits
    where window_start < now() - make_interval(secs => p_window_seconds * 10);

  return v_count <= p_limit;
end;
$$;

comment on function openiwatch.check_ingest_rate is
  'Returns false when the caller has exceeded the ingestion rate limit for the current window.';

do $$
declare
  t text;
begin
  foreach t in array array['scoring_thresholds', 'escalation_rules']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function openiwatch.touch_row()',
      t || '_touch', t
    );
    execute format('drop trigger if exists %I on public.%I', t || '_stamp', t);
    execute format(
      'create trigger %I before insert on public.%I for each row execute function openiwatch.stamp_row()',
      t || '_stamp', t
    );
  end loop;
end
$$;
