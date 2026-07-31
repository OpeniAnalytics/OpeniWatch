-- =============================================================================
-- OpeniWatch 0010 — web push subscriptions and automatic escalation
-- =============================================================================
-- Adds:
--   * push_subscriptions      — opt-in web push registrations, per user/device
--   * escalation_rules        — automation columns (enable flag, notify level)
--   * alert_escalations       — provenance columns so an automated escalation is
--                               always distinguishable from a human one
--   * notification_deliveries — dedupe key so a scheduled job cannot double-send
--   * system_settings         — organization-level kill switch for outbound
--                               notifications
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Web push subscriptions
-- -----------------------------------------------------------------------------
-- Registration is explicitly opt-in and stores the minimum needed to route a
-- push: the provider's own subscription identifier, tied to an authenticated
-- OpeniWatch user. No device fingerprint, no location, no advertising id.
-- -----------------------------------------------------------------------------

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'onesignal' check (provider in ('onesignal')),
  -- The provider's subscription/player identifier. Opaque to OpeniWatch.
  provider_subscription_id text not null,
  -- Coarse label only, for an operator to recognise their own devices in a
  -- list. Never a fingerprint.
  device_label text,
  is_enabled boolean not null default true,
  -- Set when the provider reports the subscription is gone, so the dispatcher
  -- stops trying rather than failing forever.
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (provider, provider_subscription_id)
);

comment on table public.push_subscriptions is
  'Opt-in web push registrations. Stores only the provider subscription id and an optional user-chosen device label.';
comment on column public.push_subscriptions.provider_subscription_id is
  'Opaque provider identifier. OpeniWatch never derives location or identity from it.';

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id) where is_enabled and revoked_at is null;

-- -----------------------------------------------------------------------------
-- Notification delivery: de-duplication and honest status vocabulary
-- -----------------------------------------------------------------------------

alter table public.notification_deliveries
  add column if not exists dedupe_key text;

comment on column public.notification_deliveries.dedupe_key is
  'Identifies one logical delivery attempt (alert + user + channel + path step). A unique index on it makes the dispatcher and the scheduled escalator safe to re-run.';

-- Partial unique index: one delivery per logical attempt. Rows without a key
-- (historical, or intentionally repeated manual sends) are unaffected.
create unique index if not exists notification_deliveries_dedupe_idx
  on public.notification_deliveries (dedupe_key)
  where dedupe_key is not null;

-- `queued` and `disabled` are distinct from `pending` and `skipped`:
--   queued   — accepted by OpeniWatch, not yet handed to a provider
--   sent     — the provider accepted it; NOT proof of delivery
--   delivered— the provider confirmed delivery to the device
--   disabled — the channel is switched off by configuration or by the user
do $$
begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'delivery_status' and e.enumlabel = 'queued'
  ) then
    alter type public.delivery_status add value 'queued';
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'delivery_status' and e.enumlabel = 'disabled'
  ) then
    alter type public.delivery_status add value 'disabled';
  end if;
end
$$;

-- Provider response, stored verbatim for reconciliation. Never contains keys:
-- the dispatcher strips authorization headers before recording.
alter table public.notification_deliveries
  add column if not exists provider_response jsonb not null default '{}'::jsonb;

alter table public.notification_deliveries
  add column if not exists push_subscription_id uuid
    references public.push_subscriptions (id) on delete set null;

-- -----------------------------------------------------------------------------
-- Escalation automation
-- -----------------------------------------------------------------------------

alter table public.escalation_rules
  add column if not exists auto_escalate boolean not null default false;

alter table public.escalation_rules
  add column if not exists notify_roles public.app_role[] not null
    default '{soc_manager,program_admin}'::public.app_role[];

comment on column public.escalation_rules.auto_escalate is
  'When true, a scheduled job escalates an alert of this severity that is still unacknowledged after unacknowledged_seconds. Off by default; an administrator enables it per program and severity.';
comment on column public.escalation_rules.notify_roles is
  'Roles notified by an automatic escalation. OpeniWatch never contacts emergency services or a reported subject.';

-- Staging defaults: critical after 5 minutes, high after 15. Moderate and
-- informational stay off — an automated page for a queue-length complaint would
-- destroy trust in the alerting channel.
update public.escalation_rules
   set auto_escalate = true
 where severity in ('critical', 'high')
   and auto_escalate = false;

-- Provenance on the escalation record itself.
alter table public.alert_escalations
  add column if not exists is_automated boolean not null default false;

alter table public.alert_escalations
  add column if not exists triggered_by_rule_id uuid
    references public.escalation_rules (id) on delete set null;

alter table public.alert_escalations
  add column if not exists unacknowledged_seconds integer;

comment on column public.alert_escalations.is_automated is
  'True when a scheduled job raised this escalation. An automated escalation is never presented as a human decision.';
comment on column public.alert_escalations.unacknowledged_seconds is
  'Elapsed time without acknowledgment that triggered an automated escalation.';

-- `escalated_by` is NOT NULL, because a human escalation must be attributable.
-- An automated escalation has no acting user, so relax it and constrain instead:
-- either a human escalated it, or it is flagged automated.
alter table public.alert_escalations
  alter column escalated_by drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'alert_escalations_actor_check'
  ) then
    alter table public.alert_escalations
      add constraint alert_escalations_actor_check
      check ((is_automated and escalated_by is null) or escalated_by is not null);
  end if;
end
$$;

-- Idempotency: one automated escalation per alert per rule. A scheduled job
-- that runs every minute must not stack escalations on the same alert.
create unique index if not exists alert_escalations_auto_once_idx
  on public.alert_escalations (alert_id, triggered_by_rule_id)
  where is_automated;

-- -----------------------------------------------------------------------------
-- Organization settings, including the outbound notification kill switch
-- -----------------------------------------------------------------------------

create table if not exists public.system_settings (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  -- Emergency stop. When false, no provider call is attempted on any channel;
  -- deliveries are recorded as `disabled` with the reason. In-app notifications
  -- continue, because silencing the application itself would hide alerts from
  -- the operators looking straight at it.
  outbound_notifications_enabled boolean not null default true,
  outbound_disabled_reason text,
  outbound_disabled_at timestamptz,
  outbound_disabled_by uuid references auth.users (id) on delete set null,
  -- Automatic escalation can be switched off for the whole organization,
  -- independent of the per-severity rules.
  auto_escalation_enabled boolean not null default true,
  -- Staging banner. Rendered by the interface when set.
  environment_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.system_settings is
  'Organization-level operational controls: the outbound notification kill switch, automatic escalation master switch, and the environment banner.';

insert into public.system_settings (organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

-- -----------------------------------------------------------------------------
-- Triggers, RLS and privileges for the new tables
-- -----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['push_subscriptions', 'system_settings']
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
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end
$$;

-- A user manages only their own push registrations.
drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and openiwatch.is_org_member(organization_id));

-- Administrators may see registrations in order to diagnose delivery, but the
-- rows carry no content — only an opaque provider id.
drop policy if exists push_subscriptions_admin_read on public.push_subscriptions;
create policy push_subscriptions_admin_read on public.push_subscriptions
  for select to authenticated
  using (openiwatch.can_administer(organization_id));

drop policy if exists system_settings_select on public.system_settings;
create policy system_settings_select on public.system_settings
  for select to authenticated
  using (openiwatch.is_org_member(organization_id));

drop policy if exists system_settings_admin on public.system_settings;
create policy system_settings_admin on public.system_settings
  for all to authenticated
  using (openiwatch.can_administer(organization_id))
  with check (openiwatch.can_administer(organization_id));

grant select, insert, update, delete on public.push_subscriptions
  to authenticated, service_role;
grant select, insert, update, delete on public.system_settings
  to authenticated, service_role;

-- A user may withdraw consent by deleting their registration; nobody else may.
revoke delete on public.system_settings from authenticated;
