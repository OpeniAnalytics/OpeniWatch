-- =============================================================================
-- OpeniWatch 0008 — pilot seed data
-- =============================================================================
-- Seeds one configurable organization, the "Costco Pilot" program, seven
-- physical locations and eight operational assignments (Plano #696 carries
-- two), plus the threat taxonomy, scoring thresholds, escalation rules and
-- connector registry rows.
--
-- The organization NAME is deliberately not hardcoded: the security-services
-- partner may be renamed. Override at apply time with
--   set openiwatch.org_name = 'Your Organization';
-- or rename the row afterwards. The slug and id stay stable so foreign keys
-- and seeded references survive a rename.
--
-- This migration is idempotent: re-running it updates the seeded rows in place
-- rather than duplicating them.
--
-- No auth.users rows are created here. Supabase user creation requires the
-- Admin API — see scripts/seed-users.mjs and docs/PILOT_SETUP.md.
-- =============================================================================

do $$
declare
  v_org_id    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_program_id uuid := 'a0000000-0000-4000-8000-000000000002';
  v_org_name  text := coalesce(
    nullif(current_setting('openiwatch.org_name', true), ''),
    'Openi Security Services'
  );
begin

  -- ---------------------------------------------------------------------------
  -- Organization and program
  -- ---------------------------------------------------------------------------
  insert into public.organizations (id, name, slug, contact_email, is_active)
  values (v_org_id, v_org_name, 'openi-security-services', null, true)
  on conflict (id) do update
    set name = excluded.name,
        is_active = excluded.is_active;

  insert into public.programs
    (id, organization_id, name, slug, client_name, description, signal_retention_days, is_active)
  values (
    v_program_id, v_org_id, 'Costco Pilot', 'costco-pilot', 'Costco Wholesale',
    'Eight-assignment pilot supporting security operations for seven Costco warehouse locations.',
    365, true
  )
  on conflict (id) do update
    set name = excluded.name,
        client_name = excluded.client_name,
        description = excluded.description;

  -- ---------------------------------------------------------------------------
  -- Protected locations
  -- ---------------------------------------------------------------------------
  -- Latitude/longitude are approximate values seeded without a paid geocoding
  -- service (geocode_source = 'seeded_approximate'). They are accurate enough
  -- for vicinity matching and must be re-geocoded before production use.
  -- ---------------------------------------------------------------------------
  insert into public.locations (
    id, organization_id, program_id, facility_number, official_name,
    address_line1, address_line2, city, county, state, postal_code, country_code,
    latitude, longitude, time_zone, geocode_source, nearby_landmarks, store_features, is_active
  )
  values
    (
      'b0000000-0000-4000-8000-000000000001', v_org_id, v_program_id, '1487', 'Costco #1487',
      '12717 Network Drive', null, 'Stafford', 'Fort Bend', 'TX', '77477', 'US',
      29.6280, -95.5560, 'America/Chicago', 'seeded_approximate',
      array['Southwest Freeway (US-59/I-69)', 'Stafford Centre'],
      array['Warehouse', 'Fuel station', 'Tire center', 'Surface parking lot'], true
    ),
    (
      'b0000000-0000-4000-8000-000000000002', v_org_id, v_program_id, '696', 'Costco #696',
      '1701 Dallas Parkway', null, 'Plano', 'Collin', 'TX', '75093', 'US',
      33.0295, -96.8290, 'America/Chicago', 'seeded_approximate',
      array['Dallas North Tollway', 'Willow Bend'],
      array['Warehouse', 'Fuel station', 'Pharmacy', 'Surface parking lot'], true
    ),
    (
      'b0000000-0000-4000-8000-000000000003', v_org_id, v_program_id, '01147', 'Costco #01147',
      '3900 Dublin St.', null, 'New Orleans', 'Orleans Parish', 'LA', '70118', 'US',
      29.9525, -90.1345, 'America/Chicago', 'seeded_approximate',
      array['Carrollton', 'Earhart Boulevard', 'Mississippi River levee'],
      array['Warehouse', 'Fuel station', 'Surface parking lot'], true
    ),
    (
      'b0000000-0000-4000-8000-000000000004', v_org_id, v_program_id, '353', 'Costco #353',
      '3775 Hacks Cross Rd.', null, 'Memphis', 'Shelby', 'TN', '38125', 'US',
      35.0295, -89.8135, 'America/Chicago', 'seeded_approximate',
      array['Hacks Cross Road corridor', 'Winchester Road'],
      array['Warehouse', 'Fuel station', 'Tire center', 'Surface parking lot'], true
    ),
    (
      'b0000000-0000-4000-8000-000000000005', v_org_id, v_program_id, '1115', 'Costco #1115',
      '7940 Richmond Highway', null, 'Alexandria', 'Fairfax', 'VA', '22306', 'US',
      38.7435, -77.0795, 'America/New_York', 'seeded_approximate',
      array['Richmond Highway (US-1)', 'Mount Vernon', 'Huntington'],
      array['Warehouse', 'Fuel station', 'Pharmacy', 'Surface parking lot'], true
    ),
    (
      'b0000000-0000-4000-8000-000000000006', v_org_id, v_program_id, '1381', 'Costco #1381',
      '1500 US-287', 'Building #100', 'Mansfield', 'Tarrant', 'TX', '76063', 'US',
      32.5735, -97.1265, 'America/Chicago', 'seeded_approximate',
      array['US-287 Highway', 'Broad Street'],
      array['Warehouse', 'Fuel station', 'Surface parking lot'], true
    ),
    (
      'b0000000-0000-4000-8000-000000000007', v_org_id, v_program_id, '1211', 'Costco #1211',
      '791 N. Krocks Rd.', null, 'Allentown', 'Lehigh', 'PA', '18106', 'US',
      40.5765, -75.5595, 'America/New_York', 'seeded_approximate',
      array['Route 222', 'Hamilton Boulevard', 'Lehigh Valley'],
      array['Warehouse', 'Fuel station', 'Tire center', 'Surface parking lot'], true
    )
  on conflict (id) do update
    set official_name = excluded.official_name,
        address_line1 = excluded.address_line1,
        address_line2 = excluded.address_line2,
        city = excluded.city,
        county = excluded.county,
        state = excluded.state,
        postal_code = excluded.postal_code,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        time_zone = excluded.time_zone,
        nearby_landmarks = excluded.nearby_landmarks,
        store_features = excluded.store_features,
        is_active = excluded.is_active;

  -- ---------------------------------------------------------------------------
  -- Location aliases — how the public actually refers to these stores
  -- ---------------------------------------------------------------------------
  insert into public.location_aliases (location_id, alias, alias_type)
  values
    ('b0000000-0000-4000-8000-000000000001', 'Costco Stafford', 'colloquial'),
    ('b0000000-0000-4000-8000-000000000001', 'Stafford Costco', 'colloquial'),
    ('b0000000-0000-4000-8000-000000000002', 'Costco Plano', 'colloquial'),
    ('b0000000-0000-4000-8000-000000000002', 'Plano Costco', 'colloquial'),
    ('b0000000-0000-4000-8000-000000000003', 'Costco Carrollton', 'local_reference'),
    ('b0000000-0000-4000-8000-000000000003', 'Costco New Orleans', 'colloquial'),
    ('b0000000-0000-4000-8000-000000000004', 'Costco Hacks Cross', 'local_reference'),
    ('b0000000-0000-4000-8000-000000000004', 'Costco Memphis', 'colloquial'),
    -- The client's own local reference for #1115.
    ('b0000000-0000-4000-8000-000000000005', 'Mt. Vernon', 'local_reference'),
    ('b0000000-0000-4000-8000-000000000005', 'Mount Vernon Costco', 'colloquial'),
    ('b0000000-0000-4000-8000-000000000005', 'Costco Alexandria', 'colloquial'),
    ('b0000000-0000-4000-8000-000000000006', 'Costco Mansfield', 'colloquial'),
    ('b0000000-0000-4000-8000-000000000007', 'Costco Allentown', 'colloquial'),
    ('b0000000-0000-4000-8000-000000000007', 'Costco Krocks Road', 'local_reference')
  on conflict (location_id, alias) do nothing;

  -- ---------------------------------------------------------------------------
  -- Operational assignments
  -- ---------------------------------------------------------------------------
  -- Eight assignments across seven physical locations. Assignments 2 and 4 both
  -- reference Costco #696 in Plano.
  -- ---------------------------------------------------------------------------
  insert into public.operational_assignments (
    id, organization_id, program_id, location_id, name, assignment_number, coverage_notes, is_active
  )
  values
    ('c0000000-0000-4000-8000-000000000001', v_org_id, v_program_id,
     'b0000000-0000-4000-8000-000000000001', 'Costco 1487 Stafford, TX', 1, null, true),
    ('c0000000-0000-4000-8000-000000000002', v_org_id, v_program_id,
     'b0000000-0000-4000-8000-000000000002', 'Costco 696 Plano, TX Assignment 1', 2,
     'First of two assignments covering the same physical warehouse.', true),
    ('c0000000-0000-4000-8000-000000000003', v_org_id, v_program_id,
     'b0000000-0000-4000-8000-000000000003', 'Costco 01147 New Orleans, LA', 3, null, true),
    ('c0000000-0000-4000-8000-000000000004', v_org_id, v_program_id,
     'b0000000-0000-4000-8000-000000000002', 'Costco 696 Plano, TX Assignment 2', 4,
     'Second of two assignments covering the same physical warehouse.', true),
    ('c0000000-0000-4000-8000-000000000005', v_org_id, v_program_id,
     'b0000000-0000-4000-8000-000000000004', 'Costco 353 Memphis, TN', 5, null, true),
    ('c0000000-0000-4000-8000-000000000006', v_org_id, v_program_id,
     'b0000000-0000-4000-8000-000000000005', 'Costco 1115 Mt. Vernon, VA', 6, null, true),
    ('c0000000-0000-4000-8000-000000000007', v_org_id, v_program_id,
     'b0000000-0000-4000-8000-000000000006', 'Costco 1381 Mansfield, TX', 7, null, true),
    ('c0000000-0000-4000-8000-000000000008', v_org_id, v_program_id,
     'b0000000-0000-4000-8000-000000000007', 'Costco 1211 Allentown, PA', 8, null, true)
  on conflict (id) do update
    set name = excluded.name,
        location_id = excluded.location_id,
        assignment_number = excluded.assignment_number,
        coverage_notes = excluded.coverage_notes,
        is_active = excluded.is_active;

  -- ---------------------------------------------------------------------------
  -- Geofences — property and vicinity rings per location
  -- ---------------------------------------------------------------------------
  insert into public.location_geofences (
    location_id, name, shape, center_latitude, center_longitude, radius_meters, zone
  )
  select l.id, 'Property', 'circle', l.latitude, l.longitude, 200, 'property'
    from public.locations l where l.program_id = v_program_id and l.latitude is not null
  on conflict (location_id, name) do nothing;

  insert into public.location_geofences (
    location_id, name, shape, center_latitude, center_longitude, radius_meters, zone
  )
  select l.id, 'Parking area', 'circle', l.latitude, l.longitude, 400, 'parking'
    from public.locations l where l.program_id = v_program_id and l.latitude is not null
  on conflict (location_id, name) do nothing;

  insert into public.location_geofences (
    location_id, name, shape, center_latitude, center_longitude, radius_meters, zone
  )
  select l.id, 'Vicinity', 'circle', l.latitude, l.longitude, 1600, 'vicinity'
    from public.locations l where l.program_id = v_program_id and l.latitude is not null
  on conflict (location_id, name) do nothing;

  -- ---------------------------------------------------------------------------
  -- Scoring thresholds and escalation rules
  -- ---------------------------------------------------------------------------
  insert into public.scoring_thresholds (
    organization_id, critical_min, high_min, moderate_min,
    auto_suppress_below, minimum_location_confidence, scorer_id
  )
  values (v_org_id, 80, 60, 35, 10, 25, 'deterministic-v1')
  on conflict (organization_id) do update
    set critical_min = excluded.critical_min,
        high_min = excluded.high_min,
        moderate_min = excluded.moderate_min,
        auto_suppress_below = excluded.auto_suppress_below,
        minimum_location_confidence = excluded.minimum_location_confidence,
        scorer_id = excluded.scorer_id;

  -- Critical alerts walk in-app -> web push -> SMS fallback, then escalate if
  -- still unacknowledged. OpeniWatch never contacts emergency services.
  insert into public.escalation_rules (
    organization_id, program_id, severity, unacknowledged_seconds, escalate_to, channel_path, is_active
  )
  values
    (v_org_id, null, 'critical', 300, 'soc_supervisor',
     '{in_app,web_push,sms}'::public.delivery_channel[], true),
    (v_org_id, null, 'high', 900, 'soc_supervisor',
     '{in_app,web_push}'::public.delivery_channel[], true),
    (v_org_id, null, 'moderate', 3600, 'soc_supervisor',
     '{in_app}'::public.delivery_channel[], true),
    (v_org_id, null, 'informational', 86400, 'soc_supervisor',
     '{in_app}'::public.delivery_channel[], true)
  on conflict do nothing;

  -- ---------------------------------------------------------------------------
  -- Connector registry
  -- ---------------------------------------------------------------------------
  -- `status` records exactly how complete each integration is, so the
  -- administration screen never implies a connector works when it does not.
  -- ---------------------------------------------------------------------------
  insert into public.integrations (id, organization_id, kind, name, status, config, is_enabled)
  values
    ('d0000000-0000-4000-8000-000000000001', v_org_id, 'manual', 'Manual analyst submission',
     'implemented', '{}'::jsonb, true),
    ('d0000000-0000-4000-8000-000000000002', v_org_id, 'generic_webhook', 'Secure ingest webhook',
     'implemented', '{"endpoint":"/functions/v1/ingest-signal","auth":"shared secret header"}'::jsonb, true),
    ('d0000000-0000-4000-8000-000000000003', v_org_id, 'simulator', 'Development signal simulator',
     'simulated', '{"scenarios":8}'::jsonb, true),
    ('d0000000-0000-4000-8000-000000000004', v_org_id, 'zignal', 'Zignal / Spyglass',
     'requires_vendor_documentation',
     '{"note":"Endpoint paths, auth scheme and payload shape must come from vendor documentation. No endpoints are fabricated in this codebase."}'::jsonb,
     false),
    ('d0000000-0000-4000-8000-000000000005', v_org_id, 'rss', 'RSS / news feeds',
     'requires_credentials', '{"note":"Set RSS_FEED_URLS to activate."}'::jsonb, false),
    ('d0000000-0000-4000-8000-000000000006', v_org_id, 'public_safety', 'Public safety feed',
     'requires_credentials', '{"note":"Requires an agency-provided endpoint and key."}'::jsonb, false)
  on conflict (id) do update
    set name = excluded.name,
        status = excluded.status,
        config = excluded.config,
        is_enabled = excluded.is_enabled;

  insert into public.collection_sources (id, organization_id, integration_id, platform, name, is_enabled)
  values
    ('e0000000-0000-4000-8000-000000000001', v_org_id, 'd0000000-0000-4000-8000-000000000001',
     'Analyst', 'Manual analyst submission', true),
    ('e0000000-0000-4000-8000-000000000002', v_org_id, 'd0000000-0000-4000-8000-000000000002',
     'Public web source', 'Secure ingest webhook', true),
    ('e0000000-0000-4000-8000-000000000003', v_org_id, 'd0000000-0000-4000-8000-000000000003',
     'Public web source', 'Development simulator', true)
  on conflict (id) do update
    set platform = excluded.platform,
        name = excluded.name,
        is_enabled = excluded.is_enabled;

end
$$;

-- -----------------------------------------------------------------------------
-- Threat taxonomy
-- -----------------------------------------------------------------------------
-- Administrators may deactivate categories or add their own; nothing in the
-- application treats this list as closed.
-- -----------------------------------------------------------------------------

insert into public.threat_categories
  (organization_id, key, label, "group", baseline_severity, severity_weight, description)
values
  ('a0000000-0000-4000-8000-000000000001', 'direct_threat', 'Direct threat', 'violence', 'critical', 92,
   'An explicit stated intent to harm a location, its staff, or its customers.'),
  ('a0000000-0000-4000-8000-000000000001', 'weapon_or_firearm', 'Weapon or firearm', 'violence', 'critical', 90,
   'A weapon or firearm is reported as present, displayed, or brandished.'),
  ('a0000000-0000-4000-8000-000000000001', 'active_violence', 'Active violence', 'violence', 'critical', 98,
   'Violence reported as in progress.'),
  ('a0000000-0000-4000-8000-000000000001', 'assault_or_confrontation', 'Assault or confrontation', 'violence', 'high', 70,
   'Physical altercation or aggressive confrontation involving staff or customers.'),
  ('a0000000-0000-4000-8000-000000000001', 'bomb_or_explosive_threat', 'Bomb or explosive threat', 'violence', 'critical', 95,
   'A threat referencing an explosive device.'),
  ('a0000000-0000-4000-8000-000000000001', 'fire_or_evacuation', 'Fire or evacuation', 'environment', 'high', 78,
   'Fire, smoke, alarm activation, or an evacuation in progress.'),
  ('a0000000-0000-4000-8000-000000000001', 'suspicious_activity', 'Suspicious activity', 'safety', 'moderate', 48,
   'Behavior reported as suspicious without a confirmed threat.'),
  ('a0000000-0000-4000-8000-000000000001', 'organized_retail_crime', 'Organized retail crime', 'crime', 'high', 66,
   'Coordinated theft activity, flash-mob theft, or fencing operations.'),
  ('a0000000-0000-4000-8000-000000000001', 'robbery_or_theft', 'Robbery or theft', 'crime', 'high', 64,
   'Robbery, shoplifting, or property theft affecting the location.'),
  ('a0000000-0000-4000-8000-000000000001', 'protest_or_disruption', 'Protest or organized disruption', 'disruption', 'moderate', 52,
   'Planned or ongoing protest, walkout, or organized disruption.'),
  ('a0000000-0000-4000-8000-000000000001', 'dangerous_crowd_condition', 'Dangerous crowd condition', 'safety', 'high', 68,
   'Crowd density, surge, or behavior that creates a safety risk.'),
  ('a0000000-0000-4000-8000-000000000001', 'harassment', 'Harassment', 'safety', 'moderate', 44,
   'Harassment of staff or customers, including targeted verbal abuse.'),
  ('a0000000-0000-4000-8000-000000000001', 'customer_or_employee_safety', 'Customer or employee safety', 'safety', 'moderate', 46,
   'A general safety concern affecting customers or employees.'),
  ('a0000000-0000-4000-8000-000000000001', 'medical_emergency', 'Medical emergency', 'safety', 'high', 62,
   'A medical emergency reported at or immediately outside the location.'),
  ('a0000000-0000-4000-8000-000000000001', 'nearby_police_activity', 'Nearby police activity', 'disruption', 'moderate', 50,
   'Law-enforcement activity near the location that may affect access.'),
  ('a0000000-0000-4000-8000-000000000001', 'nearby_external_incident', 'Nearby external incident', 'disruption', 'moderate', 45,
   'An incident in the vicinity that is not on the protected property.'),
  ('a0000000-0000-4000-8000-000000000001', 'severe_weather', 'Severe weather', 'environment', 'moderate', 47,
   'Severe weather affecting the location or its access routes.'),
  ('a0000000-0000-4000-8000-000000000001', 'infrastructure_disruption', 'Infrastructure or utility disruption', 'environment', 'moderate', 42,
   'Power, water, network, or other utility disruption.'),
  ('a0000000-0000-4000-8000-000000000001', 'transportation_disruption', 'Transportation or access disruption', 'disruption', 'moderate', 40,
   'Road closure, traffic incident, or transit disruption affecting access.'),
  ('a0000000-0000-4000-8000-000000000001', 'customer_experience_disruption', 'General customer-experience disruption', 'other', 'informational', 18,
   'Service complaints, wait times, product availability. Reported for awareness, not for urgent dispatch.'),
  ('a0000000-0000-4000-8000-000000000001', 'other_operational_concern', 'Other operational concern', 'other', 'informational', 25,
   'An operational concern that does not fit an existing category.')
on conflict (organization_id, key) do update
  set label = excluded.label,
      "group" = excluded."group",
      baseline_severity = excluded.baseline_severity,
      severity_weight = excluded.severity_weight,
      description = excluded.description;
