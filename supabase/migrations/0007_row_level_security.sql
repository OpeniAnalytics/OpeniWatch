-- =============================================================================
-- OpeniWatch 0007 — Row Level Security
-- =============================================================================
-- Rules enforced here:
--   * A user sees only organizations, programs, locations, signals and alerts
--     reachable through their memberships.
--   * Only analysts and program administrators may validate candidate alerts.
--   * Only program administrators (and super administrators) may change roles,
--     memberships, programs, locations, thresholds and escalation rules.
--   * audit_events is append-only for everyone.
--   * The service role bypasses RLS and is used exclusively by server-side
--     Edge Functions.
-- =============================================================================

-- Enable RLS everywhere. FORCE so that even a table owner is subject to it.
do $$
declare
  t text;
begin
  foreach t in array array[
    'organizations', 'programs', 'profiles', 'organization_memberships',
    'program_memberships', 'user_roles', 'locations', 'location_aliases',
    'operational_assignments', 'location_geofences', 'location_contacts',
    'integrations', 'collection_sources', 'signal_authors', 'signals',
    'signal_media', 'signal_location_matches', 'signal_duplicates',
    'threat_categories', 'candidate_alerts', 'alerts', 'alert_evidence',
    'alert_assignments', 'alert_acknowledgments', 'alert_escalations',
    'alert_dispositions', 'alert_comments', 'notification_subscriptions',
    'notification_deliveries', 'audit_events', 'scoring_thresholds',
    'escalation_rules', 'ingest_rate_limits'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- Organizations, programs, profiles, memberships, roles
-- -----------------------------------------------------------------------------

drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  for select to authenticated
  using (openiwatch.is_org_member(id));

drop policy if exists organizations_write on public.organizations;
create policy organizations_write on public.organizations
  for update to authenticated
  using (openiwatch.can_administer(id))
  with check (openiwatch.can_administer(id));

drop policy if exists organizations_insert on public.organizations;
create policy organizations_insert on public.organizations
  for insert to authenticated
  with check (openiwatch.is_super_admin());

drop policy if exists programs_select on public.programs;
create policy programs_select on public.programs
  for select to authenticated
  using (openiwatch.is_org_member(organization_id) and openiwatch.is_program_member(id));

drop policy if exists programs_admin on public.programs;
create policy programs_admin on public.programs
  for all to authenticated
  using (openiwatch.can_administer(organization_id))
  with check (openiwatch.can_administer(organization_id));

-- Profiles: a user always sees their own; organization members see colleagues
-- so that alerts can display assignee and acknowledger names.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.organization_memberships mine
      join public.organization_memberships theirs
        on theirs.organization_id = mine.organization_id
      where mine.user_id = auth.uid()
        and theirs.user_id = public.profiles.user_id
    )
    or openiwatch.is_super_admin()
  );

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists profiles_admin on public.profiles;
create policy profiles_admin on public.profiles
  for all to authenticated
  using (
    openiwatch.is_super_admin()
    or exists (
      select 1 from public.organization_memberships m
      where m.user_id = public.profiles.user_id
        and openiwatch.can_administer(m.organization_id)
    )
  )
  with check (
    openiwatch.is_super_admin()
    or exists (
      select 1 from public.organization_memberships m
      where m.user_id = public.profiles.user_id
        and openiwatch.can_administer(m.organization_id)
    )
  );

drop policy if exists organization_memberships_select on public.organization_memberships;
create policy organization_memberships_select on public.organization_memberships
  for select to authenticated
  using (user_id = auth.uid() or openiwatch.is_org_member(organization_id));

drop policy if exists organization_memberships_admin on public.organization_memberships;
create policy organization_memberships_admin on public.organization_memberships
  for all to authenticated
  using (openiwatch.can_administer(organization_id))
  with check (openiwatch.can_administer(organization_id));

drop policy if exists program_memberships_select on public.program_memberships;
create policy program_memberships_select on public.program_memberships
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.programs p
      where p.id = public.program_memberships.program_id
        and openiwatch.is_org_member(p.organization_id)
    )
  );

drop policy if exists program_memberships_admin on public.program_memberships;
create policy program_memberships_admin on public.program_memberships
  for all to authenticated
  using (
    exists (
      select 1 from public.programs p
      where p.id = public.program_memberships.program_id
        and openiwatch.can_administer(p.organization_id)
    )
  )
  with check (
    exists (
      select 1 from public.programs p
      where p.id = public.program_memberships.program_id
        and openiwatch.can_administer(p.organization_id)
    )
  );

-- Roles are readable by the holder and by organization members (needed to show
-- "who can validate"), but writable ONLY by administrators. This is the
-- protection against unauthorized privilege escalation: a user cannot grant
-- themselves a role because the WITH CHECK clause never consults the row being
-- inserted for the acting user's authority.
drop policy if exists user_roles_select on public.user_roles;
create policy user_roles_select on public.user_roles
  for select to authenticated
  using (
    user_id = auth.uid()
    or (organization_id is not null and openiwatch.is_org_member(organization_id))
    or openiwatch.is_super_admin()
  );

drop policy if exists user_roles_admin on public.user_roles;
create policy user_roles_admin on public.user_roles
  for all to authenticated
  using (
    openiwatch.is_super_admin()
    or (organization_id is not null and openiwatch.can_administer(organization_id))
  )
  with check (
    -- Only a super administrator may mint another super administrator.
    case when role = 'super_admin' then openiwatch.is_super_admin()
         else openiwatch.is_super_admin()
              or (organization_id is not null and openiwatch.can_administer(organization_id))
    end
  );

-- -----------------------------------------------------------------------------
-- Protected locations
-- -----------------------------------------------------------------------------

drop policy if exists locations_select on public.locations;
create policy locations_select on public.locations
  for select to authenticated
  using (openiwatch.is_program_member(program_id));

drop policy if exists locations_admin on public.locations;
create policy locations_admin on public.locations
  for all to authenticated
  using (openiwatch.can_administer(organization_id))
  with check (openiwatch.can_administer(organization_id));

-- Child tables of `locations` inherit visibility from the parent row.
do $$
declare
  t text;
begin
  foreach t in array array['location_aliases', 'location_geofences', 'location_contacts']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($f$
      create policy %I on public.%I
        for select to authenticated
        using (exists (
          select 1 from public.locations l
          where l.id = %I.location_id
            and openiwatch.is_program_member(l.program_id)
        ))
    $f$, t || '_select', t, t);

    execute format('drop policy if exists %I on public.%I', t || '_admin', t);
    execute format($f$
      create policy %I on public.%I
        for all to authenticated
        using (exists (
          select 1 from public.locations l
          where l.id = %I.location_id
            and openiwatch.can_administer(l.organization_id)
        ))
        with check (exists (
          select 1 from public.locations l
          where l.id = %I.location_id
            and openiwatch.can_administer(l.organization_id)
        ))
    $f$, t || '_admin', t, t, t);
  end loop;
end
$$;

drop policy if exists operational_assignments_select on public.operational_assignments;
create policy operational_assignments_select on public.operational_assignments
  for select to authenticated
  using (openiwatch.is_program_member(program_id));

drop policy if exists operational_assignments_admin on public.operational_assignments;
create policy operational_assignments_admin on public.operational_assignments
  for all to authenticated
  using (openiwatch.can_administer(organization_id))
  with check (openiwatch.can_administer(organization_id));

-- -----------------------------------------------------------------------------
-- Collection and signals
-- -----------------------------------------------------------------------------

drop policy if exists integrations_select on public.integrations;
create policy integrations_select on public.integrations
  for select to authenticated
  using (openiwatch.is_org_member(organization_id));

drop policy if exists integrations_admin on public.integrations;
create policy integrations_admin on public.integrations
  for all to authenticated
  using (openiwatch.can_administer(organization_id))
  with check (openiwatch.can_administer(organization_id));

drop policy if exists collection_sources_select on public.collection_sources;
create policy collection_sources_select on public.collection_sources
  for select to authenticated
  using (openiwatch.is_org_member(organization_id));

drop policy if exists collection_sources_admin on public.collection_sources;
create policy collection_sources_admin on public.collection_sources
  for all to authenticated
  using (openiwatch.can_administer(organization_id))
  with check (openiwatch.can_administer(organization_id));

drop policy if exists signal_authors_select on public.signal_authors;
create policy signal_authors_select on public.signal_authors
  for select to authenticated
  using (openiwatch.is_org_member(organization_id));

drop policy if exists signal_authors_write on public.signal_authors;
create policy signal_authors_write on public.signal_authors
  for all to authenticated
  using (openiwatch.can_validate(organization_id))
  with check (openiwatch.can_validate(organization_id));

drop policy if exists signals_select on public.signals;
create policy signals_select on public.signals
  for select to authenticated
  using (openiwatch.is_program_member(program_id));

-- Analysts may submit signals manually. Nobody may edit a signal after the
-- fact: there is no UPDATE policy, so original evidence is immutable to every
-- application role.
drop policy if exists signals_insert on public.signals;
create policy signals_insert on public.signals
  for insert to authenticated
  with check (
    openiwatch.can_validate(organization_id)
    and openiwatch.is_program_member(program_id)
    and collection_method = 'manual_submission'
  );

drop policy if exists signals_admin_delete on public.signals;
create policy signals_admin_delete on public.signals
  for delete to authenticated
  using (openiwatch.can_administer(organization_id));

-- Child tables of `signals`.
do $$
declare
  t text;
begin
  foreach t in array array['signal_media', 'signal_location_matches', 'signal_duplicates']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($f$
      create policy %I on public.%I
        for select to authenticated
        using (exists (
          select 1 from public.signals s
          where s.id = %I.signal_id
            and openiwatch.is_program_member(s.program_id)
        ))
    $f$, t || '_select', t, t);

    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($f$
      create policy %I on public.%I
        for all to authenticated
        using (exists (
          select 1 from public.signals s
          where s.id = %I.signal_id
            and openiwatch.can_validate(s.organization_id)
        ))
        with check (exists (
          select 1 from public.signals s
          where s.id = %I.signal_id
            and openiwatch.can_validate(s.organization_id)
        ))
    $f$, t || '_write', t, t, t);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- Threat categories
-- -----------------------------------------------------------------------------

drop policy if exists threat_categories_select on public.threat_categories;
create policy threat_categories_select on public.threat_categories
  for select to authenticated
  using (openiwatch.is_org_member(organization_id));

drop policy if exists threat_categories_admin on public.threat_categories;
create policy threat_categories_admin on public.threat_categories
  for all to authenticated
  using (openiwatch.can_administer(organization_id))
  with check (openiwatch.can_administer(organization_id));

-- -----------------------------------------------------------------------------
-- Candidate alerts — the validation gate
-- -----------------------------------------------------------------------------

drop policy if exists candidate_alerts_select on public.candidate_alerts;
create policy candidate_alerts_select on public.candidate_alerts
  for select to authenticated
  using (openiwatch.is_program_member(program_id));

-- Only analysts and program administrators may triage or decide a candidate.
-- SOC operators, SOC managers and viewers have read access only, which is what
-- prevents unauthorized alert validation.
drop policy if exists candidate_alerts_review on public.candidate_alerts;
create policy candidate_alerts_review on public.candidate_alerts
  for update to authenticated
  using (openiwatch.can_validate(organization_id) and openiwatch.is_program_member(program_id))
  with check (openiwatch.can_validate(organization_id) and openiwatch.is_program_member(program_id));

drop policy if exists candidate_alerts_insert on public.candidate_alerts;
create policy candidate_alerts_insert on public.candidate_alerts
  for insert to authenticated
  with check (openiwatch.can_validate(organization_id) and openiwatch.is_program_member(program_id));

-- -----------------------------------------------------------------------------
-- Alerts and SOC operations
-- -----------------------------------------------------------------------------

drop policy if exists alerts_select on public.alerts;
create policy alerts_select on public.alerts
  for select to authenticated
  using (openiwatch.is_program_member(program_id));

-- Creating an alert IS validation, so it is gated on can_validate. The
-- additional check enforces that validated_by is the acting user: an analyst
-- cannot attribute a validation to someone else.
drop policy if exists alerts_insert on public.alerts;
create policy alerts_insert on public.alerts
  for insert to authenticated
  with check (
    openiwatch.can_validate(organization_id)
    and openiwatch.is_program_member(program_id)
    and validated_by = auth.uid()
  );

-- SOC operations (acknowledge, assign, escalate, resolve, close, dispose)
-- update the alert row and are open to the wider operational group.
drop policy if exists alerts_operate on public.alerts;
create policy alerts_operate on public.alerts
  for update to authenticated
  using (openiwatch.can_operate(organization_id) and openiwatch.is_program_member(program_id))
  with check (openiwatch.can_operate(organization_id) and openiwatch.is_program_member(program_id));

-- Alert child tables: read for program members, write for operational roles.
do $$
declare
  t text;
begin
  foreach t in array array[
    'alert_evidence', 'alert_assignments', 'alert_acknowledgments',
    'alert_escalations', 'alert_dispositions', 'alert_comments'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($f$
      create policy %I on public.%I
        for select to authenticated
        using (exists (
          select 1 from public.alerts a
          where a.id = %I.alert_id
            and openiwatch.is_program_member(a.program_id)
        ))
    $f$, t || '_select', t, t);

    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format($f$
      create policy %I on public.%I
        for insert to authenticated
        with check (exists (
          select 1 from public.alerts a
          where a.id = %I.alert_id
            and openiwatch.can_operate(a.organization_id)
            and openiwatch.is_program_member(a.program_id)
        ))
    $f$, t || '_insert', t, t);
  end loop;
end
$$;

-- Acknowledgments and comments are attributable: you may only record your own.
drop policy if exists alert_acknowledgments_insert on public.alert_acknowledgments;
create policy alert_acknowledgments_insert on public.alert_acknowledgments
  for insert to authenticated
  with check (
    acknowledged_by = auth.uid()
    and exists (
      select 1 from public.alerts a
      where a.id = public.alert_acknowledgments.alert_id
        and openiwatch.can_operate(a.organization_id)
        and openiwatch.is_program_member(a.program_id)
    )
  );

drop policy if exists alert_comments_insert on public.alert_comments;
create policy alert_comments_insert on public.alert_comments
  for insert to authenticated
  with check (
    author_user_id = auth.uid()
    and exists (
      select 1 from public.alerts a
      where a.id = public.alert_comments.alert_id
        and openiwatch.can_operate(a.organization_id)
        and openiwatch.is_program_member(a.program_id)
    )
  );

drop policy if exists alert_escalations_insert on public.alert_escalations;
create policy alert_escalations_insert on public.alert_escalations
  for insert to authenticated
  with check (
    escalated_by = auth.uid()
    and exists (
      select 1 from public.alerts a
      where a.id = public.alert_escalations.alert_id
        and openiwatch.can_operate(a.organization_id)
        and openiwatch.is_program_member(a.program_id)
    )
  );

-- -----------------------------------------------------------------------------
-- Notifications
-- -----------------------------------------------------------------------------

drop policy if exists notification_subscriptions_own on public.notification_subscriptions;
create policy notification_subscriptions_own on public.notification_subscriptions
  for all to authenticated
  using (user_id = auth.uid() and openiwatch.is_org_member(organization_id))
  with check (user_id = auth.uid() and openiwatch.is_org_member(organization_id));

drop policy if exists notification_subscriptions_admin on public.notification_subscriptions;
create policy notification_subscriptions_admin on public.notification_subscriptions
  for all to authenticated
  using (openiwatch.can_administer(organization_id))
  with check (openiwatch.can_administer(organization_id));

-- A user sees their own deliveries; managers and administrators see the full
-- delivery history because it is part of the operational record of an alert.
drop policy if exists notification_deliveries_select on public.notification_deliveries;
create policy notification_deliveries_select on public.notification_deliveries
  for select to authenticated
  using (
    user_id = auth.uid()
    or openiwatch.has_org_role(
         organization_id,
         array['soc_manager', 'program_admin', 'analyst']::public.app_role[]
       )
  );

-- Marking an in-app notification read is the only client-side delivery write.
drop policy if exists notification_deliveries_own_update on public.notification_deliveries;
create policy notification_deliveries_own_update on public.notification_deliveries
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Audit trail — append only
-- -----------------------------------------------------------------------------

drop policy if exists audit_events_select on public.audit_events;
create policy audit_events_select on public.audit_events
  for select to authenticated
  using (openiwatch.is_org_member(organization_id));

drop policy if exists audit_events_insert on public.audit_events;
create policy audit_events_insert on public.audit_events
  for insert to authenticated
  with check (openiwatch.is_org_member(organization_id) and actor_user_id = auth.uid());

-- No UPDATE or DELETE policy exists. Combined with the immutability trigger in
-- 0005, audit events cannot be altered by any application role.

-- -----------------------------------------------------------------------------
-- Administration settings
-- -----------------------------------------------------------------------------

drop policy if exists scoring_thresholds_select on public.scoring_thresholds;
create policy scoring_thresholds_select on public.scoring_thresholds
  for select to authenticated
  using (openiwatch.is_org_member(organization_id));

drop policy if exists scoring_thresholds_admin on public.scoring_thresholds;
create policy scoring_thresholds_admin on public.scoring_thresholds
  for all to authenticated
  using (openiwatch.can_administer(organization_id))
  with check (openiwatch.can_administer(organization_id));

drop policy if exists escalation_rules_select on public.escalation_rules;
create policy escalation_rules_select on public.escalation_rules
  for select to authenticated
  using (openiwatch.is_org_member(organization_id));

drop policy if exists escalation_rules_admin on public.escalation_rules;
create policy escalation_rules_admin on public.escalation_rules
  for all to authenticated
  using (openiwatch.can_administer(organization_id))
  with check (openiwatch.can_administer(organization_id));

-- ingest_rate_limits has RLS enabled and NO policies: only the service role
-- (which bypasses RLS) can read or write it.

-- -----------------------------------------------------------------------------
-- Realtime
-- -----------------------------------------------------------------------------
-- Realtime respects RLS, so subscribers receive only rows they may read.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.alerts;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.candidate_alerts;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.notification_deliveries;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.alert_acknowledgments;
    exception when duplicate_object then null;
    end;
  end if;
end
$$;
