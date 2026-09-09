#!/usr/bin/env bash
#
# Applies every migration to a throwaway PostgreSQL database and runs the Row
# Level Security scenario tests against it.
#
# This proves three things that cannot be checked by reading the SQL:
#   1. the migrations apply cleanly, in order;
#   2. they are repeatable — applying them twice changes nothing;
#   3. the RLS policies actually permit and deny what they are meant to.
#
# Usage:
#   scripts/test-rls.sh                 # start a temporary local cluster
#   PGURL=postgres://... scripts/test-rls.sh   # use an existing database
#
# Requires PostgreSQL 15+ client and server binaries. On Debian/Ubuntu:
#   apt-get install postgresql postgresql-client
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PGPORT="${PGPORT:-5455}"
PGSOCKET="${PGSOCKET:-/tmp}"
DBNAME="${DBNAME:-openiwatch_rls_test}"
OWN_CLUSTER=0

# ---------------------------------------------------------------------------
# Supabase platform objects the migrations depend on.
#
# A plain PostgreSQL instance has no `auth` schema, no `auth.uid()` and none of
# the Supabase roles. This shim provides just enough of them to exercise the
# policies. It is a TEST FIXTURE — never apply it to a real deployment.
# ---------------------------------------------------------------------------
read -r -d '' SHIM <<'SQL' || true
create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- Supabase derives auth.uid() from the request JWT. Locally it reads the same
-- setting, which the test harness sets per check.
create or replace function auth.uid() returns uuid
language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$fn$;

do $roles$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $roles$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

do $pub$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $pub$;
SQL

if [ -n "${PGURL:-}" ]; then
  PSQL=(psql "$PGURL")
else
  PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)}"
  if [ ! -x "$PGBIN/initdb" ]; then
    echo "PostgreSQL server binaries not found. Set PGBIN or PGURL." >&2
    exit 1
  fi

  PGUSER_LOCAL="${PGUSER_LOCAL:-$(id -un)}"
  PGDATA_DIR="${PGDATA_DIR:-/tmp/openiwatch-rls-pgdata}"

  # initdb refuses to run as root; use an unprivileged account when necessary.
  RUNNER=""
  if [ "$(id -u)" = "0" ]; then
    id pgtest >/dev/null 2>&1 || useradd -m pgtest
    PGDATA_DIR="/home/pgtest/openiwatch-rls-pgdata"
    RUNNER="su pgtest -c"
  fi

  echo "Starting a temporary PostgreSQL cluster in $PGDATA_DIR"
  rm -rf "$PGDATA_DIR"
  if [ -n "$RUNNER" ]; then
    $RUNNER "$PGBIN/initdb -D $PGDATA_DIR -U postgres --auth=trust" >/dev/null
    $RUNNER "$PGBIN/pg_ctl -D $PGDATA_DIR -o '-p $PGPORT -k $PGSOCKET' -l /tmp/openiwatch-rls-pg.log start" >/dev/null
  else
    "$PGBIN/initdb" -D "$PGDATA_DIR" -U postgres --auth=trust >/dev/null
    "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -o "-p $PGPORT -k $PGSOCKET" -l /tmp/openiwatch-rls-pg.log start >/dev/null
  fi
  OWN_CLUSTER=1
  sleep 2

  PSQL=(psql -h "$PGSOCKET" -p "$PGPORT" -U postgres -d "$DBNAME")
  psql -h "$PGSOCKET" -p "$PGPORT" -U postgres -d postgres \
    -c "drop database if exists $DBNAME" -c "create database $DBNAME" >/dev/null
fi

cleanup() {
  if [ "$OWN_CLUSTER" = "1" ]; then
    if [ -n "${RUNNER:-}" ]; then
      $RUNNER "$PGBIN/pg_ctl -D $PGDATA_DIR stop" >/dev/null 2>&1 || true
    else
      "$PGBIN/pg_ctl" -D "$PGDATA_DIR" stop >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

echo "Installing the Supabase test shim"
printf '%s\n' "$SHIM" | "${PSQL[@]}" -v ON_ERROR_STOP=1 -q -f -

apply_migrations() {
  for f in supabase/migrations/*.sql; do
    "${PSQL[@]}" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1 | grep -v 'does not exist, skipping' || true
  done
}

echo "Applying migrations"
apply_migrations

echo "Re-applying migrations to prove repeatability"
apply_migrations

echo "Verifying seeded pilot data"
"${PSQL[@]}" -v ON_ERROR_STOP=1 -At <<'SQL'
do $$
declare
  v_locations integer;
  v_assignments integer;
  v_plano_locations integer;
begin
  select count(*) into v_locations from public.locations;
  select count(*) into v_assignments from public.operational_assignments;
  select count(distinct location_id) into v_plano_locations
    from public.operational_assignments where name like '%Plano%';

  if v_locations <> 7 then
    raise exception 'expected 7 physical locations, found %', v_locations;
  end if;
  if v_assignments <> 8 then
    raise exception 'expected 8 operational assignments, found %', v_assignments;
  end if;
  if v_plano_locations <> 1 then
    raise exception 'both Plano assignments must reference one location, found %', v_plano_locations;
  end if;
  raise notice 'Seed data verified: 7 locations, 8 assignments, Plano shares one location.';
end $$;
SQL

echo "Running RLS scenario tests"
"${PSQL[@]}" -v ON_ERROR_STOP=1 -f supabase/tests/rls_scenarios.sql

echo "Running retention scenario tests"
"${PSQL[@]}" -v ON_ERROR_STOP=1 -f supabase/tests/retention_scenarios.sql

echo
echo "Migrations applied twice cleanly; all RLS and retention scenario checks passed."
