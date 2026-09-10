-- =============================================================================
-- OpeniWatch 0013 — function exposure, privileges and search_path
-- =============================================================================
-- Three findings, one root cause: 0009 granted EXECUTE on *every* function in
-- the openiwatch schema to anon and authenticated, and the schema is not
-- exposed through PostgREST. That combination is both a latent privilege
-- problem and a functional bug, and the obvious fix for the bug triggers the
-- privilege problem.
--
--  1. ingest-signal calls rpc('check_ingest_rate'), unqualified. PostgREST
--     resolves RPC names in the exposed schemas, which are public and
--     graphql_public. The function lives only in openiwatch, so the call cannot
--     resolve and the endpoint would answer 503 on every request once its
--     secrets are set. This has never been observed because the function has
--     never had its secrets.
--
--  2. The tempting fix -- adding openiwatch to Exposed Schemas -- would publish
--     every helper in it. anon currently holds EXECUTE on openiwatch.run_
--     retention, which deletes signals. Exposing the schema would let an
--     unauthenticated caller purge operational data over HTTP.
--
--  3. Five trigger functions carry a mutable search_path (advisor
--     0011_function_search_path_mutable), including the one that keeps
--     audit_events append-only.
--
-- The fix is to publish one narrow wrapper instead of a schema, withdraw the
-- grants that were never needed, and pin the search_path everywhere.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. A public wrapper for the rate limiter
-- -----------------------------------------------------------------------------
-- This is the only openiwatch function any client legitimately calls by RPC.
-- Publishing just this one keeps the rest of the schema unreachable over HTTP.
--
-- SECURITY DEFINER so it can write ingest_rate_limits, which has RLS enabled
-- and no policy (deny-all by design -- see 0006). search_path is pinned so the
-- body cannot be redirected by a caller's setting.

create or replace function public.check_ingest_rate(
  p_bucket_key text,
  p_limit integer default 120,
  p_window_seconds integer default 60
)
returns boolean
language sql
security definer
set search_path = openiwatch, public, pg_temp
as $$
  select openiwatch.check_ingest_rate(p_bucket_key, p_limit, p_window_seconds);
$$;

comment on function public.check_ingest_rate is
  'PostgREST-reachable wrapper for openiwatch.check_ingest_rate. Exists so the ingest Edge Function can call it by RPC without the openiwatch schema being exposed. Executable by service_role only.';

-- Only the ingest function, which authenticates with the project secret key,
-- may call this. A browser client has no business consuming rate-limit budget.
revoke all on function public.check_ingest_rate(text, integer, integer) from public;
revoke all on function public.check_ingest_rate(text, integer, integer) from anon, authenticated;
grant execute on function public.check_ingest_rate(text, integer, integer) to service_role;


-- -----------------------------------------------------------------------------
-- 2. Withdraw the grants that were never needed
-- -----------------------------------------------------------------------------
-- 0009 grants EXECUTE on all functions in openiwatch to authenticated and
-- service_role, and anon inherited it. The RLS helper functions genuinely need
-- it: they are evaluated inside policy expressions, as the querying role, so
-- revoking from them would turn "zero rows" into "permission denied".
--
-- These three are different. None is referenced by any policy; all are called
-- server-side with the secret key. anon and authenticated never need them, and
-- run_retention in particular deletes data.

-- Revoked by name rather than by signature, so this keeps working if an
-- argument list changes later and cannot silently miss an overload.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'openiwatch'
       and p.proname in ('run_retention', 'retention_report', 'check_ingest_rate')
  loop
    -- PUBLIC first. PostgreSQL grants EXECUTE to PUBLIC on every function at
    -- creation, so revoking from anon and authenticated alone changes nothing:
    -- both still hold it through PUBLIC.
    execute format('revoke all on function %s from public', fn.signature);
    execute format('revoke all on function %s from anon, authenticated', fn.signature);

    -- Then grant service_role back explicitly, rather than trusting that 0009
    -- already did. 0009 runs `grant execute on all functions in schema
    -- openiwatch`, which only covers functions that existed when it ran --
    -- run_retention and retention_report arrive in 0012, two migrations later.
    -- On a database where the migrations were applied once, in order, those two
    -- reached service_role through PUBLIC alone, so revoking PUBLIC above takes
    -- them away and the retention job stops working.
    --
    -- This is invisible to a test harness that applies every migration twice:
    -- on the second pass 0009 re-runs with all the functions present and grants
    -- them properly. Production gets one pass.
    execute format('grant execute on function %s to service_role', fn.signature);
  end loop;
end
$$;


-- -----------------------------------------------------------------------------
-- 3. Pin search_path on the trigger functions
-- -----------------------------------------------------------------------------
-- These five run SECURITY INVOKER, with the caller's own privileges, and they
-- stay that way: making them SECURITY DEFINER to satisfy a linter would grant
-- them the definer's rights for no reason, which is a larger change than the
-- one being fixed.
--
-- Pinning search_path still matters. reject_audit_mutation is what makes
-- audit_events append-only, and OpeniWatch treats that table as evidentiary. A
-- guard whose unqualified names resolve through a caller-controlled search_path
-- is a guard whose behaviour depends on who is calling it. That is not
-- reachable today -- Postgres 15 revoked CREATE on public, and neither anon nor
-- authenticated can create a schema -- but it is one grant away from being
-- reachable, and that grant could be made by someone who has no idea this
-- depends on it.

alter function openiwatch.touch_row() set search_path = public, pg_temp;
alter function openiwatch.stamp_row() set search_path = public, pg_temp;
alter function openiwatch.reject_audit_mutation() set search_path = public, pg_temp;
alter function openiwatch.protect_automated_assessment() set search_path = public, pg_temp;
alter function openiwatch.guard_alert_lifecycle() set search_path = public, pg_temp;
