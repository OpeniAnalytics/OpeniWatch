-- =============================================================================
-- OpeniWatch 0009 — table privileges
-- =============================================================================
-- Row Level Security decides WHICH ROWS a user may touch. Table privileges
-- decide whether they may touch the table at all. Both are required: a policy
-- has no effect if the role lacks the underlying privilege.
--
-- Supabase grants `authenticated` broad privileges on `public` by default, so
-- omitting this file would appear to work there — and would fail on a plain
-- PostgreSQL instance, or if that default ever changed. Declaring privileges
-- explicitly makes the schema self-contained and reviewable.
--
-- The pattern is: grant what the policies permit, then revoke the operations
-- that must never be possible for any application role regardless of policy.
-- =============================================================================

do $$
begin
  -- These roles exist on Supabase. Create them when applying to a plain
  -- PostgreSQL instance (local testing, CI) so the file applies cleanly.
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema openiwatch to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

-- The authorization helpers are SECURITY DEFINER and read-only; policies call
-- them on behalf of the acting user, so the role must be able to execute them.
grant execute on all functions in schema openiwatch to authenticated, service_role;

-- Broad DML on public, governed by RLS. `anon` gets nothing: OpeniWatch has no
-- unauthenticated surface.
grant select, insert, update, delete on all tables in schema public
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Revocations: operations no application role may ever perform
-- ---------------------------------------------------------------------------

-- Collected evidence is immutable. There is no UPDATE policy on signals, and
-- removing the privilege makes that structural rather than policy-dependent.
revoke update on public.signals from authenticated;

-- The audit trail is append-only. Enforced three ways: no UPDATE/DELETE policy,
-- the audit_events_immutable trigger, and no privilege.
revoke update, delete on public.audit_events from authenticated;

-- Ingest rate limiting is service-role only. RLS is enabled on this table with
-- no policies, and the privilege is removed as well.
revoke all on public.ingest_rate_limits from authenticated, anon;

-- Deleting an alert or a candidate would destroy the operational record. The
-- lifecycle uses `closed` status and dispositions instead.
revoke delete on public.alerts from authenticated;
revoke delete on public.candidate_alerts from authenticated;
revoke delete on public.alert_acknowledgments from authenticated;
revoke delete on public.alert_escalations from authenticated;
revoke delete on public.alert_dispositions from authenticated;
revoke delete on public.alert_comments from authenticated;

-- Sequences are unused (all keys are UUIDs), but grant for completeness so a
-- future serial column does not fail confusingly.
grant usage, select on all sequences in schema public to authenticated, service_role;

-- Anything added later inherits the same defaults.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to authenticated, service_role;
