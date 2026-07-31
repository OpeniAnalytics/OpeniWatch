-- =============================================================================
-- OpeniWatch 0011 — coordinate verification metadata
-- =============================================================================
-- The pilot coordinates were seeded approximately, without a geocoding service.
-- This migration adds the fields needed to record a real verification, and
-- explicitly marks every existing coordinate as UNVERIFIED.
--
-- It does not invent verified coordinates. Marking an approximate coordinate
-- "verified" would be worse than leaving it approximate: an operator would
-- trust a geofence that was never checked. Verification requires an
-- authoritative geocoding run or a manual check against the client's own
-- records — see docs/PILOT_SETUP.md.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'coordinate_verification_status') then
    create type public.coordinate_verification_status as enum (
      -- Seeded from public address data without a geocoding service. Adequate
      -- for vicinity matching; NOT adequate for dispatch.
      'unverified',
      -- A geocoding service returned these coordinates.
      'geocoded',
      -- A person checked them against imagery or the client's own record.
      'manually_verified',
      -- Checked and found wrong; needs correction before use.
      'disputed',
      -- The address itself is ambiguous (multiple candidate sites).
      'ambiguous'
    );
  end if;
end
$$;

alter table public.locations
  add column if not exists coordinate_verification_status
    public.coordinate_verification_status not null default 'unverified';

alter table public.locations
  add column if not exists coordinate_verification_method text;

alter table public.locations
  add column if not exists coordinate_verified_at timestamptz;

alter table public.locations
  add column if not exists coordinate_verified_by uuid
    references auth.users (id) on delete set null;

-- Radius of uncertainty around the recorded point, in metres. Null means not
-- assessed — which is different from zero.
alter table public.locations
  add column if not exists coordinate_uncertainty_meters integer
    check (coordinate_uncertainty_meters is null or coordinate_uncertainty_meters >= 0);

alter table public.locations
  add column if not exists address_ambiguity_notes text;

comment on column public.locations.coordinate_verification_status is
  'How much trust the coordinates carry. Defaults to unverified; nothing in the application may present an unverified coordinate as confirmed.';
comment on column public.locations.coordinate_verification_method is
  'Free text: which geocoding service and version, or how a person verified it.';
comment on column public.locations.coordinate_uncertainty_meters is
  'Radius of uncertainty in metres. Null means not assessed, which is not the same as zero.';

-- Every seeded location is explicitly unverified, with the reason recorded.
update public.locations
   set coordinate_verification_status = 'unverified',
       coordinate_verification_method =
         'Seeded from the published street address without a geocoding service. Accurate to roughly the correct block; adequate for vicinity matching only.',
       coordinate_uncertainty_meters = 250,
       coordinate_verified_at = null,
       coordinate_verified_by = null
 where geocode_source = 'seeded_approximate'
   and coordinate_verification_status = 'unverified'
   and coordinate_verification_method is null;

-- A verified status must say how it was verified and when. This makes it
-- impossible to flip the flag without recording the evidence.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'locations_verification_evidence_check'
  ) then
    alter table public.locations
      add constraint locations_verification_evidence_check
      check (
        coordinate_verification_status in ('unverified', 'ambiguous', 'disputed')
        or (coordinate_verification_method is not null and coordinate_verified_at is not null)
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Geofence radius should reflect coordinate uncertainty
-- ---------------------------------------------------------------------------
-- A 200 m "property" ring around a point that could be 250 m out is a false
-- precision. While coordinates are unverified, widen the property and parking
-- rings so a match is not silently missed, and record why.
-- ---------------------------------------------------------------------------

alter table public.location_geofences
  add column if not exists radius_rationale text;

update public.location_geofences g
   set radius_meters = greatest(g.radius_meters, 450),
       radius_rationale =
         'Widened while the location coordinates are unverified (±250 m). Narrow this once coordinates are geocoded or manually verified.'
  from public.locations l
 where l.id = g.location_id
   and g.zone in ('property', 'parking')
   and l.coordinate_verification_status = 'unverified'
   and g.radius_rationale is null;

comment on column public.location_geofences.radius_rationale is
  'Why this radius was chosen. Set when a radius is widened to absorb coordinate uncertainty.';
