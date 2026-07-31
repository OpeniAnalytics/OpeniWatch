-- =============================================================================
-- OpeniWatch 0002 — organizations, programs, profiles, memberships, roles
-- =============================================================================
-- The multi-tenant hierarchy is:
--   organization -> program -> protected location -> operational assignment
--                -> users and notification subscriptions
-- =============================================================================

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  contact_email text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  constraint organizations_name_not_blank check (length(btrim(name)) > 0)
);

comment on table public.organizations is
  'Top-level tenant. The pilot organization name is configurable because the security-services partner may be renamed.';

create table if not exists public.programs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  slug text not null,
  client_name text,
  description text,
  signal_retention_days integer check (signal_retention_days is null or signal_retention_days > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (organization_id, slug)
);

comment on column public.programs.signal_retention_days is
  'Program-level retention policy. Null inherits the platform default. Drives restricted-retention purges.';

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null,
  title text,
  phone text,
  time_zone text not null default 'America/Chicago',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.profiles is
  'Application profile for an authenticated user. One row per auth.users record.';

create table if not exists public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (organization_id, user_id)
);

create table if not exists public.program_memberships (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.programs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (program_id, user_id)
);

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.app_role not null,
  organization_id uuid references public.organizations (id) on delete cascade,
  program_id uuid references public.programs (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  -- Only super_admin may be platform-wide (no organization scope).
  constraint user_roles_scope_check check (
    organization_id is not null or role = 'super_admin'
  )
);

comment on table public.user_roles is
  'Roles are stored separately from profiles so that a privilege check never depends on a user-writable row.';

-- A user holds a given role at most once per (organization, program) scope.
create unique index if not exists user_roles_unique_scope
  on public.user_roles (user_id, role, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(program_id, '00000000-0000-0000-0000-000000000000'::uuid));

create index if not exists user_roles_user_idx on public.user_roles (user_id);
create index if not exists organization_memberships_user_idx on public.organization_memberships (user_id);
create index if not exists program_memberships_user_idx on public.program_memberships (user_id);
create index if not exists programs_organization_idx on public.programs (organization_id);

-- -----------------------------------------------------------------------------
-- Authorization helpers
-- -----------------------------------------------------------------------------
-- These are SECURITY DEFINER so that RLS policies on user_roles /
-- organization_memberships do not recurse when a policy on another table asks
-- "what roles does this user hold?". They read only, never write.
-- -----------------------------------------------------------------------------

create or replace function openiwatch.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role = 'super_admin'
  );
$$;

create or replace function openiwatch.has_org_role(target_org uuid, allowed public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select openiwatch.is_super_admin()
      or exists (
        select 1 from public.user_roles ur
        where ur.user_id = auth.uid()
          and ur.organization_id = target_org
          and ur.role = any (allowed)
      );
$$;

create or replace function openiwatch.is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select openiwatch.is_super_admin()
      or exists (
        select 1 from public.organization_memberships m
        where m.user_id = auth.uid()
          and m.organization_id = target_org
      );
$$;

-- Program access: an explicit program membership, or an organization-level
-- administrator who implicitly covers every program in the organization.
create or replace function openiwatch.is_program_member(target_program uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select openiwatch.is_super_admin()
      or exists (
        select 1 from public.program_memberships pm
        where pm.user_id = auth.uid()
          and pm.program_id = target_program
      )
      or exists (
        select 1
        from public.programs p
        join public.user_roles ur
          on ur.organization_id = p.organization_id
         and ur.user_id = auth.uid()
         and ur.role in ('program_admin', 'soc_manager')
        where p.id = target_program
      );
$$;

/**
 * Only analysts and administrators may validate candidate alerts.
 * SOC operators and viewers must never be able to promote a candidate.
 */
create or replace function openiwatch.can_validate(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select openiwatch.has_org_role(target_org, array['analyst', 'program_admin']::public.app_role[]);
$$;

/** SOC actions: acknowledge, assign, escalate, resolve, close, dispose. */
create or replace function openiwatch.can_operate(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select openiwatch.has_org_role(
    target_org,
    array['soc_manager', 'soc_operator', 'analyst', 'program_admin']::public.app_role[]
  );
$$;

/** Administration surface: users, roles, programs, locations, settings. */
create or replace function openiwatch.can_administer(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select openiwatch.has_org_role(target_org, array['program_admin']::public.app_role[]);
$$;

-- -----------------------------------------------------------------------------
-- Timestamp triggers
-- -----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'organizations', 'programs', 'profiles',
    'organization_memberships', 'program_memberships', 'user_roles'
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
