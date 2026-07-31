-- =============================================================================
-- OpeniWatch 0001 — extensions, schema, and operational enums
-- =============================================================================
-- Every migration in this project is written to be re-runnable. Enum creation
-- is wrapped so that re-applying the file against an existing database is a
-- no-op rather than an error.
-- =============================================================================

create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "pg_trgm" with schema extensions;

-- Helper/security functions live in a dedicated schema so that nothing in
-- `public` can be shadowed by a table of the same name.
create schema if not exists openiwatch;

comment on schema openiwatch is
  'OpeniWatch internal helper functions (authorization, hashing, scoring support).';

-- -----------------------------------------------------------------------------
-- Enum types
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum (
      'super_admin',
      'program_admin',
      'analyst',
      'soc_manager',
      'soc_operator',
      'viewer'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'candidate_status') then
    create type public.candidate_status as enum (
      'pending_review',
      'under_review',
      'validated',
      'rejected',
      'duplicate',
      'suppressed'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'alert_status') then
    create type public.alert_status as enum (
      'open',
      'acknowledged',
      'assigned',
      'escalated',
      'monitoring',
      'resolved',
      'closed'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'severity_level') then
    create type public.severity_level as enum (
      'critical',
      'high',
      'moderate',
      'informational'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'alert_disposition_value') then
    create type public.alert_disposition_value as enum (
      'confirmed',
      'credible_unconfirmed',
      'unconfirmed',
      'false_positive',
      'duplicate',
      'outdated',
      'wrong_location',
      'non_operational',
      'resolved'
    );
  end if;

  -- Author current location. `unknown` is the mandatory default; see
  -- docs/SECURITY.md for the evidence required to move off it.
  if not exists (select 1 from pg_type where typname = 'author_location_status') then
    create type public.author_location_status as enum (
      'unknown',
      'unconfirmed',
      'reported_by_author',
      'geotagged',
      'visually_corroborated',
      'corroborated_by_source'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'author_location_evidence_kind') then
    create type public.author_location_evidence_kind as enum (
      'public_geotag',
      'coordinates_in_source',
      'contemporaneous_statement',
      'visual_evidence',
      'other_public_source'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'location_match_method') then
    create type public.location_match_method as enum (
      'explicit_geotag',
      'coordinate_proximity',
      'store_number_mention',
      'address_mention',
      'alias_mention',
      'landmark_and_city',
      'city_and_brand',
      'analyst_assigned'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'collection_method') then
    create type public.collection_method as enum (
      'manual_submission',
      'webhook',
      'connector_pull',
      'simulator'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'delivery_channel') then
    create type public.delivery_channel as enum (
      'in_app',
      'web_push',
      'sms',
      'email',
      'microsoft_teams',
      'webhook'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'delivery_status') then
    create type public.delivery_status as enum (
      'pending',
      'sent',
      'delivered',
      'failed',
      'skipped',
      'simulated'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'escalation_level') then
    create type public.escalation_level as enum (
      'soc_supervisor',
      'program_manager',
      'client_regional',
      'client_executive'
    );
  end if;

  -- Automated assessment, analyst assessment and SOC disposition must always
  -- remain distinguishable.
  if not exists (select 1 from pg_type where typname = 'assessment_source') then
    create type public.assessment_source as enum ('automated', 'analyst', 'soc');
  end if;

  if not exists (select 1 from pg_type where typname = 'connector_kind') then
    create type public.connector_kind as enum (
      'zignal',
      'rss',
      'public_safety',
      'manual',
      'generic_webhook',
      'simulator'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'integration_status') then
    create type public.integration_status as enum (
      'implemented',
      'simulated',
      'stubbed',
      'requires_credentials',
      'requires_vendor_documentation'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'geocode_source') then
    create type public.geocode_source as enum (
      'seeded_approximate',
      'geocoding_service',
      'manual',
      'ungeocoded'
    );
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Shared trigger: maintain updated_at / updated_by
-- -----------------------------------------------------------------------------

create or replace function openiwatch.touch_row()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  -- auth.uid() is null for service-role and SQL-console writes; leave the
  -- existing value alone in that case rather than blanking provenance.
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

comment on function openiwatch.touch_row() is
  'BEFORE UPDATE trigger maintaining updated_at and updated_by on audited tables.';

create or replace function openiwatch.stamp_row()
returns trigger
language plpgsql
as $$
begin
  if new.created_by is null and auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  if new.updated_by is null then
    new.updated_by := new.created_by;
  end if;
  return new;
end;
$$;

comment on function openiwatch.stamp_row() is
  'BEFORE INSERT trigger defaulting created_by/updated_by to the acting user.';
