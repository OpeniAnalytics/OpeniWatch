-- =============================================================================
-- OpeniWatch — function privileges and search_path
-- =============================================================================
-- Run against a SINGLE pass of the migrations, before they are replayed.
--
-- That timing is the whole point. The RLS harness applies every migration twice
-- to prove they are re-runnable, and 0009 contains
--
--     grant execute on all functions in schema openiwatch to authenticated, service_role;
--
-- which only covers the functions that exist at the moment it runs. On a second
-- pass every function exists, so everything ends up explicitly granted and the
-- database looks correct. A production database applies each migration once, in
-- order, and functions created after 0009 -- run_retention and retention_report
-- arrive in 0012 -- reach service_role through PUBLIC alone.
--
-- That difference already caused a regression: revoking PUBLIC in 0013 to keep
-- anon away from run_retention also took it from service_role, and the double
-- apply hid it. These checks run where production lives, on one pass.
-- =============================================================================

create temporary table if not exists privilege_results (
  check_name text,
  passed boolean,
  detail text
);

truncate privilege_results;

create or replace function pg_temp.expect_execute(
  p_name text,
  p_role text,
  p_function text,
  p_should_have boolean
) returns void
language plpgsql
as $$
declare
  v_has boolean;
begin
  select has_function_privilege(p_role, p_function::regprocedure, 'EXECUTE') into v_has;

  insert into privilege_results (check_name, passed, detail)
  values (p_name, v_has = p_should_have,
          format('%s execute on %s = %s', p_role, p_function, v_has));

  if v_has <> p_should_have then
    raise warning 'FAIL % — expected %, got %',
      p_name,
      case when p_should_have then 'granted' else 'denied' end,
      case when v_has then 'granted' else 'denied' end;
  else
    raise notice 'PASS %', p_name;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Function privileges (migration 0013)
-- -----------------------------------------------------------------------------
-- Privilege is asserted from the catalog rather than by calling the functions.
-- run_retention deletes signals; a test that proves it is refused by running it
-- is a test that deletes data the day the grant regresses.
-- -----------------------------------------------------------------------------



do $$
begin
  -- The dangerous three. None is referenced by any policy, and all are called
  -- server-side with the project secret key.
  perform pg_temp.expect_execute(
    'anon may NOT execute run_retention', 'anon',
    'openiwatch.run_retention(uuid, boolean, uuid)', false);
  perform pg_temp.expect_execute(
    'authenticated may NOT execute run_retention', 'authenticated',
    'openiwatch.run_retention(uuid, boolean, uuid)', false);
  perform pg_temp.expect_execute(
    'anon may NOT execute retention_report', 'anon',
    'openiwatch.retention_report(uuid)', false);
  perform pg_temp.expect_execute(
    'authenticated may NOT execute retention_report', 'authenticated',
    'openiwatch.retention_report(uuid)', false);
  perform pg_temp.expect_execute(
    'anon may NOT execute the rate limiter', 'anon',
    'openiwatch.check_ingest_rate(text, integer, integer)', false);

  -- service_role still can: the retention job and the ingest function need them.
  perform pg_temp.expect_execute(
    'service_role may execute run_retention', 'service_role',
    'openiwatch.run_retention(uuid, boolean, uuid)', true);

  -- The public wrapper exists so the ingest function's rpc() call resolves
  -- without the openiwatch schema being exposed, and it is equally restricted.
  perform pg_temp.expect_execute(
    'service_role may execute the public rate limiter wrapper', 'service_role',
    'public.check_ingest_rate(text, integer, integer)', true);
  perform pg_temp.expect_execute(
    'anon may NOT execute the public rate limiter wrapper', 'anon',
    'public.check_ingest_rate(text, integer, integer)', false);
  perform pg_temp.expect_execute(
    'authenticated may NOT execute the public rate limiter wrapper', 'authenticated',
    'public.check_ingest_rate(text, integer, integer)', false);

  -- Password-credential state (migration 0014) answers a question about someone
  -- else's credentials. Provisioning only.
  perform pg_temp.expect_execute(
    'service_role may read password credential state', 'service_role',
    'public.openiwatch_user_has_password(uuid)', true);
  perform pg_temp.expect_execute(
    'anon may NOT read password credential state', 'anon',
    'public.openiwatch_user_has_password(uuid)', false);
  perform pg_temp.expect_execute(
    'authenticated may NOT read password credential state', 'authenticated',
    'public.openiwatch_user_has_password(uuid)', false);

  -- The RLS helpers must keep their grants. They are evaluated inside policy
  -- expressions as the querying role, so revoking would turn "zero rows" into
  -- "permission denied" — a different, louder, and wrong behaviour.
  perform pg_temp.expect_execute(
    'authenticated may still execute is_org_member', 'authenticated',
    'openiwatch.is_org_member(uuid)', true);
  perform pg_temp.expect_execute(
    'anon may still execute is_org_member', 'anon',
    'openiwatch.is_org_member(uuid)', true);
  perform pg_temp.expect_execute(
    'authenticated may still execute can_administer', 'authenticated',
    'openiwatch.can_administer(uuid)', true);
end
$$;

-- -----------------------------------------------------------------------------
-- service_role's grants must be explicit, not inherited from PUBLIC
-- -----------------------------------------------------------------------------
-- has_function_privilege() cannot tell an explicit grant from one held through
-- PUBLIC, so it reports "granted" either way -- and this harness applies every
-- migration twice, which hides the difference: on the second pass 0009's
-- `grant on all functions` re-runs with every function present and grants them
-- properly. Production applies once.
--
-- That combination already produced a real regression: revoking PUBLIC from
-- run_retention removed it from service_role too, because 0009 ran two
-- migrations before 0012 created it. Reading proacl is what catches it.
-- -----------------------------------------------------------------------------

do $$
declare
  fn text;
  v_acl aclitem[];
  v_explicit boolean;
begin
  foreach fn in array array[
    'openiwatch.run_retention(uuid, boolean, uuid)',
    'openiwatch.retention_report(uuid)',
    'openiwatch.check_ingest_rate(text, integer, integer)',
    'public.check_ingest_rate(text, integer, integer)',
    'public.openiwatch_user_has_password(uuid)'
  ]
  loop
    select p.proacl into v_acl from pg_proc p where p.oid = fn::regprocedure;

    -- An explicit grant appears as `service_role=X/owner`; one held through
    -- PUBLIC appears as `=X/owner`, with no grantee before the `=`.
    v_explicit := coalesce(
      array_to_string(v_acl, ' ') like '%service_role=X%', false);

    insert into privilege_results (check_name, passed, detail)
    values (format('%s grants service_role explicitly', fn), v_explicit,
            coalesce(array_to_string(v_acl, ' '), '(default acl)'));

    if v_explicit then
      raise notice 'PASS % grants service_role explicitly', fn;
    else
      raise warning 'FAIL % reaches service_role only through PUBLIC (acl: %)',
        fn, coalesce(array_to_string(v_acl, ' '), 'default');
    end if;
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- Trigger function search_path (migration 0013)
-- -----------------------------------------------------------------------------
-- The audit guard is the one that matters: a guard whose unqualified names
-- resolve through a caller-controlled search_path behaves differently depending
-- on who calls it.
-- -----------------------------------------------------------------------------

do $$
declare
  fn text;
  v_config text[];
  v_pinned boolean;
begin
  foreach fn in array array[
    'touch_row', 'stamp_row', 'reject_audit_mutation',
    'protect_automated_assessment', 'guard_alert_lifecycle'
  ]
  loop
    select p.proconfig into v_config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'openiwatch' and p.proname = fn;

    v_pinned := coalesce(array_to_string(v_config, ',') like '%search_path=%', false);

    insert into privilege_results (check_name, passed, detail)
    values (format('openiwatch.%s pins search_path', fn), v_pinned,
            coalesce(array_to_string(v_config, ','), '(none)'));

    if v_pinned then
      raise notice 'PASS openiwatch.% pins search_path', fn;
    else
      raise warning 'FAIL openiwatch.% has a mutable search_path', fn;
    end if;
  end loop;

  -- And they stay SECURITY INVOKER. Making them definers to satisfy a linter
  -- would hand them the definer's rights for no reason.
  foreach fn in array array[
    'reject_audit_mutation', 'protect_automated_assessment', 'guard_alert_lifecycle'
  ]
  loop
    select not p.prosecdef into v_pinned
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'openiwatch' and p.proname = fn;

    insert into privilege_results (check_name, passed, detail)
    values (format('openiwatch.%s stays SECURITY INVOKER', fn), v_pinned, '');

    if v_pinned then
      raise notice 'PASS openiwatch.% stays SECURITY INVOKER', fn;
    else
      raise warning 'FAIL openiwatch.% became SECURITY DEFINER', fn;
    end if;
  end loop;
end
$$;


-- -----------------------------------------------------------------------------
-- Result
-- -----------------------------------------------------------------------------

select
  count(*) filter (where passed) as passed,
  count(*) filter (where not passed) as failed,
  count(*) as total
from privilege_results;

select check_name, detail from privilege_results where not passed;

do $$
declare
  v_failed integer;
begin
  select count(*) into v_failed from privilege_results where not passed;
  if v_failed > 0 then
    raise exception '% function privilege check(s) failed', v_failed;
  end if;
  raise notice 'All function privilege checks passed.';
end
$$;
