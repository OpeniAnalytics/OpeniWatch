-- =============================================================================
-- OpeniWatch 0005 — candidate alerts, validated alerts and SOC operations
-- =============================================================================
-- Record types stay distinct throughout:
--   candidate_alerts -> a signal that MAY represent a threat (analyst queue)
--   alerts           -> a candidate an analyst validated for distribution
--   an alert acted upon by the SOC is the operational *incident*
-- =============================================================================

create table if not exists public.threat_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  key text not null,
  label text not null,
  "group" text not null,
  baseline_severity public.severity_level not null,
  severity_weight integer not null check (severity_weight between 0 and 100),
  description text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (organization_id, key)
);

comment on table public.threat_categories is
  'Threat taxonomy. Administrators may add categories or deactivate them; the application never treats the list as closed.';

create table if not exists public.candidate_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  program_id uuid not null references public.programs (id) on delete cascade,
  signal_id uuid not null references public.signals (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  operational_assignment_id uuid references public.operational_assignments (id) on delete set null,
  status public.candidate_status not null default 'pending_review',

  -- Automated assessment. Immutable once written: analyst edits go to the
  -- analyst_* columns so the two assessments never blend.
  automated_category_key text not null,
  automated_severity public.severity_level not null,
  automated_priority_score integer not null check (automated_priority_score between 0 and 100),
  automated_score jsonb not null,
  automated_explanation text not null,
  scorer_id text not null default 'deterministic-v1',

  -- Analyst assessment. Null until an analyst edits.
  analyst_category_key text,
  analyst_severity public.severity_level,
  analyst_notes text,

  -- Incident location: where the reported event is happening.
  incident_location_confidence integer not null default 0
    check (incident_location_confidence between 0 and 100),
  incident_location_method public.location_match_method,
  incident_location_evidence text[] not null default '{}',
  incident_location_assessed_by public.assessment_source not null default 'automated',

  -- Author current location: a SEPARATE fact, defaulting to unknown.
  author_location_status public.author_location_status not null default 'unknown',
  author_location_stated text,
  author_location_confidence integer not null default 0
    check (author_location_confidence between 0 and 100),
  author_location_evidence jsonb not null default '[]'::jsonb,
  author_location_assessed_by public.assessment_source not null default 'automated',

  duplicate_of_candidate_id uuid references public.candidate_alerts (id) on delete set null,
  review_started_at timestamptz,
  review_started_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null,
  decision_reason text,
  alert_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,

  unique (signal_id),
  -- Author current location may only leave 'unknown' with recorded evidence.
  constraint candidate_author_location_requires_evidence check (
    author_location_status = 'unknown'
    or jsonb_array_length(author_location_evidence) > 0
  ),
  constraint candidate_duplicate_not_self check (duplicate_of_candidate_id is null or duplicate_of_candidate_id <> id)
);

comment on constraint candidate_author_location_requires_evidence on public.candidate_alerts is
  'Author current location defaults to unknown and may only be populated when supported by recorded public evidence.';

create index if not exists candidate_alerts_queue_idx
  on public.candidate_alerts (program_id, status, automated_priority_score desc, created_at desc);
create index if not exists candidate_alerts_location_idx on public.candidate_alerts (location_id);

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  program_id uuid not null references public.programs (id) on delete cascade,
  candidate_alert_id uuid not null references public.candidate_alerts (id) on delete restrict,
  signal_id uuid not null references public.signals (id) on delete restrict,
  location_id uuid not null references public.locations (id) on delete restrict,
  operational_assignment_id uuid references public.operational_assignments (id) on delete set null,

  title text not null,
  summary text not null,
  category_key text not null,
  severity public.severity_level not null,
  status public.alert_status not null default 'open',
  priority_score integer not null check (priority_score between 0 and 100),

  incident_location_confidence integer not null check (incident_location_confidence between 0 and 100),
  incident_location_method public.location_match_method,
  incident_location_evidence text[] not null default '{}',
  incident_location_assessed_by public.assessment_source not null default 'analyst',

  author_location_status public.author_location_status not null default 'unknown',
  author_location_stated text,
  author_location_confidence integer not null default 0
    check (author_location_confidence between 0 and 100),
  author_location_evidence jsonb not null default '[]'::jsonb,
  author_location_assessed_by public.assessment_source not null default 'analyst',

  -- Lifecycle timestamps drive the detection/validation/notification/
  -- acknowledgment latency metrics in reporting.
  published_at timestamptz not null,
  detected_at timestamptz not null,
  validated_at timestamptz not null default now(),
  validated_by uuid not null references auth.users (id) on delete restrict,
  first_notified_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users (id) on delete set null,
  assigned_to uuid references auth.users (id) on delete set null,
  assigned_at timestamptz,
  escalated_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  closed_at timestamptz,
  disposition public.alert_disposition_value,
  disposition_notes text,
  -- Deep link back to the corresponding Spyglass dashboard/query/source view.
  spyglass_reference text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,

  unique (candidate_alert_id),
  constraint alert_author_location_requires_evidence check (
    author_location_status = 'unknown'
    or jsonb_array_length(author_location_evidence) > 0
  )
);

comment on table public.alerts is
  'Validated operational alerts. An alert that has been acknowledged, assigned or escalated is the operational incident.';
comment on column public.alerts.spyglass_reference is
  'Optional deep link to the Spyglass strategic monitoring layer. OpeniWatch does not embed the Spyglass dashboard.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'candidate_alerts_alert_id_fkey'
  ) then
    alter table public.candidate_alerts
      add constraint candidate_alerts_alert_id_fkey
      foreign key (alert_id) references public.alerts (id) on delete set null;
  end if;
end
$$;

create index if not exists alerts_feed_idx
  on public.alerts (program_id, status, severity, validated_at desc);
create index if not exists alerts_location_idx on public.alerts (location_id, validated_at desc);
create index if not exists alerts_assignment_idx on public.alerts (operational_assignment_id);

create table if not exists public.alert_evidence (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.alerts (id) on delete cascade,
  signal_id uuid references public.signals (id) on delete set null,
  kind text not null check (
    kind in ('source_item', 'media', 'corroborating_signal', 'analyst_attachment', 'external_link')
  ),
  label text not null,
  url text,
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

create table if not exists public.alert_assignments (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.alerts (id) on delete cascade,
  assigned_to uuid not null references auth.users (id) on delete cascade,
  assigned_by uuid not null references auth.users (id) on delete restrict,
  note text,
  unassigned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

create table if not exists public.alert_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.alerts (id) on delete cascade,
  acknowledged_by uuid not null references auth.users (id) on delete restrict,
  channel text not null default 'web_app',
  note text,
  -- Seconds between the first notification attempt and this acknowledgment.
  response_seconds integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (alert_id, acknowledged_by)
);

create table if not exists public.alert_escalations (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.alerts (id) on delete cascade,
  level public.escalation_level not null,
  escalated_by uuid not null references auth.users (id) on delete restrict,
  reason text not null,
  -- Who the SOC contacted. Free text by design: the SOC records people, not
  -- system accounts. OpeniWatch never contacts a reported subject or law
  -- enforcement automatically.
  notified_parties text[] not null default '{}',
  store_manager_notified boolean not null default false,
  regional_manager_notified boolean not null default false,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

create table if not exists public.alert_dispositions (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.alerts (id) on delete cascade,
  disposition public.alert_disposition_value not null,
  set_by uuid not null references auth.users (id) on delete restrict,
  rationale text not null default '',
  assessed_by public.assessment_source not null default 'soc',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

create table if not exists public.alert_comments (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.alerts (id) on delete cascade,
  author_user_id uuid not null references auth.users (id) on delete restrict,
  body text not null,
  kind text not null default 'operational_note'
    check (kind in ('operational_note', 'analyst_note', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

create index if not exists alert_evidence_alert_idx on public.alert_evidence (alert_id);
create index if not exists alert_assignments_alert_idx on public.alert_assignments (alert_id);
create index if not exists alert_acknowledgments_alert_idx on public.alert_acknowledgments (alert_id);
create index if not exists alert_escalations_alert_idx on public.alert_escalations (alert_id);
create index if not exists alert_dispositions_alert_idx on public.alert_dispositions (alert_id);
create index if not exists alert_comments_alert_idx on public.alert_comments (alert_id, created_at);

-- -----------------------------------------------------------------------------
-- Notification subscriptions and deliveries
-- -----------------------------------------------------------------------------

create table if not exists public.notification_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Null at any level means "everything within the enclosing scope".
  program_id uuid references public.programs (id) on delete cascade,
  location_id uuid references public.locations (id) on delete cascade,
  operational_assignment_id uuid references public.operational_assignments (id) on delete cascade,
  severities public.severity_level[] not null default '{}',
  category_keys text[] not null default '{}',
  channels public.delivery_channel[] not null default '{in_app}',
  quiet_hours_start time,
  quiet_hours_end time,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  constraint notification_subscriptions_channels_not_empty check (array_length(channels, 1) >= 1)
);

comment on column public.notification_subscriptions.severities is
  'Empty array means all severities. Same convention for category_keys.';
comment on column public.notification_subscriptions.quiet_hours_start is
  'Advisory only. Critical alerts always deliver regardless of quiet hours.';

create index if not exists notification_subscriptions_user_idx
  on public.notification_subscriptions (user_id) where is_active;

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  alert_id uuid not null references public.alerts (id) on delete cascade,
  subscription_id uuid references public.notification_subscriptions (id) on delete set null,
  user_id uuid not null references auth.users (id) on delete cascade,
  channel public.delivery_channel not null,
  status public.delivery_status not null default 'pending',
  provider_id text not null,
  provider_message_id text,
  -- Ordinal in the configured critical delivery path (1 = in-app, 2 = push,
  -- 3 = SMS fallback, 4 = escalation).
  path_step integer not null default 1,
  attempted_at timestamptz not null default now(),
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  -- Failure reason or simulation note. Never contains credentials.
  detail text,
  is_simulated boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

comment on column public.notification_deliveries.is_simulated is
  'True when no live provider credentials were configured and the delivery was recorded rather than sent.';

create index if not exists notification_deliveries_user_idx
  on public.notification_deliveries (user_id, created_at desc);
create index if not exists notification_deliveries_alert_idx
  on public.notification_deliveries (alert_id);

-- -----------------------------------------------------------------------------
-- Immutable audit trail
-- -----------------------------------------------------------------------------

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_role text not null default 'system',
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

comment on table public.audit_events is
  'Append-only record of every material action. No UPDATE or DELETE policy exists for any application role.';

create index if not exists audit_events_entity_idx
  on public.audit_events (entity_type, entity_id, occurred_at desc);
create index if not exists audit_events_org_time_idx
  on public.audit_events (organization_id, occurred_at desc);

-- Enforce append-only at the table level, independent of RLS.
create or replace function openiwatch.reject_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

drop trigger if exists audit_events_immutable on public.audit_events;
create trigger audit_events_immutable
  before update or delete on public.audit_events
  for each row execute function openiwatch.reject_audit_mutation();

do $$
declare
  t text;
begin
  foreach t in array array[
    'threat_categories', 'candidate_alerts', 'alerts', 'alert_evidence',
    'alert_assignments', 'alert_acknowledgments', 'alert_escalations',
    'alert_dispositions', 'alert_comments', 'notification_subscriptions',
    'notification_deliveries'
  ]
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
