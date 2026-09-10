-- =============================================================================
-- OpeniWatch 0014 — observing whether an account carries a password
-- =============================================================================
-- OpeniWatch's approved sign-in methods are Microsoft Entra and emailed magic
-- links. Provisioning therefore has to refuse to authorize an account that
-- still carries a password credential, because that is an unapproved second way
-- in that nobody chose.
--
-- Making that refusal real needs a way to observe the credential, and there
-- isn't one from outside the database:
--
--   * GoTrue's Admin API redacts encrypted_password from every user object it
--     returns, including admin.listUsers and admin.getUserById.
--   * auth.users is not in PostgREST's exposed schemas, so a client holding the
--     project secret key still cannot read it.
--
-- Without this function the check would compile, run, and silently never fire —
-- which is worse than not having it, because the script would report the
-- account as policy-compliant.
--
-- What is published is a boolean and nothing else. The hash never leaves the
-- database, and EXECUTE is granted to service_role alone.
-- =============================================================================

create or replace function public.openiwatch_user_has_password(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = auth, pg_temp
as $$
  select coalesce(u.encrypted_password, '') <> ''
    from auth.users u
   where u.id = p_user_id;
$$;

comment on function public.openiwatch_user_has_password is
  'True when the auth user holds a password credential. Returns null when no such user exists. Used by scripts/provision-user.mjs to refuse authorizing an account that can still sign in with a password. Returns a boolean only; the hash is never exposed. service_role only.';

-- Never a browser. This answers a question about someone else's credentials,
-- so it is restricted to the server-side key that provisioning runs with.
revoke all on function public.openiwatch_user_has_password(uuid) from public;
revoke all on function public.openiwatch_user_has_password(uuid) from anon, authenticated;
grant execute on function public.openiwatch_user_has_password(uuid) to service_role;
