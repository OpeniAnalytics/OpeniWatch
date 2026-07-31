-- =============================================================================
-- OpeniWatch 0003 — protected locations, aliases, assignments, geofences,
--                   contacts
-- =============================================================================
-- A physical location may carry more than one operational assignment. The pilot
-- has eight assignments across seven physical Costco locations (Plano #696 is
-- covered by two assignments), so `operational_assignments` is a separate table
-- rather than a column on `locations`.
-- =============================================================================

create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  program_id uuid not null references public.programs (id) on delete cascade,
  -- Stored as text: client warehouse numbers are not integers ("01147").
  facility_number text not null,
  official_name text not null,
  address_line1 text not null,
  address_line2 text,
  city text not null,
  county text,
  state text not null,
  postal_code text not null,
  country_code text not null default 'US',
  latitude double precision check (latitude is null or (latitude between -90 and 90)),
  longitude double precision check (longitude is null or (longitude between -180 and 180)),
  time_zone text not null default 'America/Chicago',
  -- Geocoding-ready: Phase 1 seeds approximate coordinates without a paid
  -- geocoding service. Swapping in a provider only updates these columns.
  geocode_source public.geocode_source not null default 'seeded_approximate',
  geocoded_at timestamptz,
  nearby_landmarks text[] not null default '{}',
  store_features text[] not null default '{}',
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (program_id, facility_number)
);

comment on column public.locations.geocode_source is
  'How latitude/longitude were obtained. Phase 1 uses seeded_approximate; no paid geocoding service is required.';

create table if not exists public.location_aliases (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  alias text not null,
  alias_type text not null default 'local_reference'
    check (alias_type in ('local_reference', 'colloquial', 'legacy_name', 'misspelling', 'other')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (location_id, alias)
);

comment on table public.location_aliases is
  'Alternate names used by the public (e.g. "Mt. Vernon" for Costco #1115). Drives alias-based location matching.';

create table if not exists public.operational_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  program_id uuid not null references public.programs (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  name text not null,
  assignment_number integer not null,
  coverage_notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (program_id, assignment_number),
  unique (program_id, name)
);

comment on table public.operational_assignments is
  'A coverage assignment against a physical location. One location may have several (e.g. Plano #696 has two).';

create index if not exists operational_assignments_location_idx
  on public.operational_assignments (location_id);

create table if not exists public.location_geofences (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  name text not null,
  shape text not null default 'circle' check (shape in ('circle')),
  center_latitude double precision not null,
  center_longitude double precision not null,
  radius_meters integer not null check (radius_meters > 0),
  zone text not null default 'property' check (zone in ('property', 'parking', 'vicinity')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (location_id, name)
);

comment on table public.location_geofences is
  'Circular zones used for coordinate-proximity location matching. Polygon support is additive and not required in Phase 1.';

create table if not exists public.location_contacts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  full_name text not null,
  role text not null,
  email text,
  phone text,
  notify_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.location_contacts is
  'Client-side contacts (store manager, regional manager, on-site security). Used to record who the SOC notified.';

create index if not exists locations_program_idx on public.locations (program_id);
create index if not exists location_contacts_location_idx on public.location_contacts (location_id);
create index if not exists location_aliases_alias_idx
  on public.location_aliases using gin (alias extensions.gin_trgm_ops);

do $$
declare
  t text;
begin
  foreach t in array array[
    'locations', 'location_aliases', 'operational_assignments',
    'location_geofences', 'location_contacts'
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
