-- =============================================================================
-- OpeniWatch 0004 — integrations, collection sources, signals and provenance
-- =============================================================================
-- A *signal* is a raw collected item: a post, article, video, report,
-- emergency notice or analyst submission. Signals are immutable evidence — the
-- application never rewrites original text, source identifiers or published
-- timestamps.
-- =============================================================================

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind public.connector_kind not null,
  name text not null,
  status public.integration_status not null default 'stubbed',
  -- Non-secret configuration only. Credentials always come from environment
  -- variables read by server-side functions.
  config jsonb not null default '{}'::jsonb,
  last_health_check_at timestamptz,
  last_health_check_ok boolean,
  last_health_check_message text,
  is_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (organization_id, kind, name)
);

comment on column public.integrations.config is
  'Non-secret connector configuration. Never store API keys here — they belong in environment variables.';

create table if not exists public.collection_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  integration_id uuid references public.integrations (id) on delete set null,
  platform text not null,
  name text not null,
  -- Opaque connector cursor for incremental pulls (getCursor / saveCursor).
  cursor text,
  cursor_updated_at timestamptz,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (organization_id, name)
);

create table if not exists public.signal_authors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  platform text not null,
  handle text not null,
  display_name text,
  -- Profile location as published by the source. This is NOT the author's
  -- current location and must never be rendered as one.
  profile_location_text text,
  profile_url text,
  profile_description text,
  source_profile_metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (organization_id, platform, handle)
);

comment on column public.signal_authors.profile_location_text is
  'Self-declared profile location string from the source. Never treat as the author''s current location.';
comment on column public.signal_authors.source_profile_metadata is
  'Public profile attributes exactly as supplied by the source. OpeniWatch never enriches or infers identity attributes.';

create table if not exists public.signals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  program_id uuid not null references public.programs (id) on delete cascade,
  collection_source_id uuid references public.collection_sources (id) on delete set null,
  author_id uuid references public.signal_authors (id) on delete set null,
  source_platform text not null,
  source_record_id text not null,
  source_url text,
  original_text text not null,
  published_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  collection_method public.collection_method not null,
  provenance text not null,
  -- SHA-256 over normalized text + platform. Drives exact duplicate detection
  -- and, together with source_record_id, webhook idempotency.
  content_hash text not null,
  raw_payload jsonb not null default '{}'::jsonb,
  source_latitude double precision check (source_latitude is null or (source_latitude between -90 and 90)),
  source_longitude double precision check (source_longitude is null or (source_longitude between -180 and 180)),
  has_public_geotag boolean not null default false,
  language text,
  is_retention_restricted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  -- Idempotency: a given source record is ingested once per platform per org.
  unique (organization_id, source_platform, source_record_id)
);

comment on table public.signals is
  'Raw collected items. Original text, source identifiers and published timestamps are never rewritten.';
comment on column public.signals.provenance is
  'Chain of custody: which connector or person collected this item and how.';
comment on column public.signals.is_retention_restricted is
  'Marks signals held under a restricted retention policy for the owning program.';

create index if not exists signals_program_published_idx
  on public.signals (program_id, published_at desc);
create index if not exists signals_content_hash_idx
  on public.signals (organization_id, content_hash);
create index if not exists signals_text_trgm_idx
  on public.signals using gin (original_text extensions.gin_trgm_ops);

create table if not exists public.signal_media (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.signals (id) on delete cascade,
  media_type text not null check (media_type in ('image', 'video', 'document', 'audio')),
  -- External reference only. Phase 1 does not re-host or proxy source media.
  url text not null,
  thumbnail_url text,
  caption text,
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.signal_media is
  'References to source media. URLs are stored, validated on render, and opened with noreferrer — never re-hosted in Phase 1.';

create index if not exists signal_media_signal_idx on public.signal_media (signal_id);

create table if not exists public.signal_location_matches (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.signals (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  method public.location_match_method not null,
  confidence integer not null check (confidence between 0 and 100),
  -- Human-readable evidence shown to the analyst verbatim.
  evidence text[] not null default '{}',
  distance_meters double precision,
  is_primary boolean not null default false,
  assessed_by public.assessment_source not null default 'automated',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (signal_id, location_id, assessed_by)
);

comment on table public.signal_location_matches is
  'Assessment of which protected location a signal concerns (incident location). Distinct from any author location assessment.';

create index if not exists signal_location_matches_location_idx
  on public.signal_location_matches (location_id);

create table if not exists public.signal_duplicates (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.signals (id) on delete cascade,
  duplicate_of_signal_id uuid not null references public.signals (id) on delete cascade,
  similarity integer not null check (similarity between 0 and 100),
  method text not null
    check (method in ('content_hash', 'near_duplicate_text', 'shared_media', 'analyst_marked')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  unique (signal_id, duplicate_of_signal_id),
  constraint signal_duplicates_not_self check (signal_id <> duplicate_of_signal_id)
);

do $$
declare
  t text;
begin
  foreach t in array array[
    'integrations', 'collection_sources', 'signal_authors', 'signals',
    'signal_media', 'signal_location_matches', 'signal_duplicates'
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
