# Data model

All tables live in `public`. Helper functions live in the `openiwatch` schema.
Every table uses UUID primary keys, and every table except `audit_events` and
`ingest_rate_limits` carries `created_at`, `updated_at`, `created_by` and
`updated_by`, maintained by triggers.

Migrations are in `supabase/migrations/` and are re-runnable.

| Migration | Contents |
| --- | --- |
| `0001_extensions_and_enums.sql` | Extensions, the `openiwatch` schema, every enum, audit triggers |
| `0002_organizations_and_access.sql` | Tenancy, profiles, memberships, roles, authorization helpers |
| `0003_protected_locations.sql` | Locations, aliases, assignments, geofences, contacts |
| `0004_collection_and_signals.sql` | Integrations, sources, signals, authors, media, matches, duplicates |
| `0005_alert_operations.sql` | Categories, candidates, alerts, SOC records, notifications, audit |
| `0006_administration_settings.sql` | Thresholds, escalation rules, lifecycle guards, rate limiting |
| `0007_row_level_security.sql` | RLS on every table, plus realtime publication |
| `0008_seed_pilot_data.sql` | The pilot organization, program, locations, assignments, taxonomy |
| `0009_privileges.sql` | Explicit table privileges, and revocations for operations no application role may perform |

---

## Hierarchy

```
organizations
  └── programs
        └── locations                    (physical warehouses)
              └── operational_assignments (coverage; a location may have several)
        └── users via program_memberships and notification_subscriptions
```

A physical location may carry more than one operational assignment. This is why
`operational_assignments` is its own table rather than columns on `locations`:
the pilot has **eight assignments across seven physical locations**, because
Costco #696 in Plano is covered by two.

---

## Organizations and access

### `organizations`
Top-level tenant. `name` is configurable — the security-services partner may be
renamed — while `id` and `slug` stay stable so references survive a rename.

### `programs`
A client engagement within an organization. Carries `client_name` and
`signal_retention_days`, which drives restricted-retention purges.

### `profiles`
One row per `auth.users` record: name, title, phone, time zone, active flag.

### `organization_memberships`, `program_memberships`
Which users can see which tenants and programs.

### `user_roles`
Roles are stored **separately from profiles** so a privilege check never depends
on a row the user can write. Values: `super_admin`, `program_admin`, `analyst`,
`soc_manager`, `soc_operator`, `viewer`.

`organization_id` is null only for `super_admin` (platform-wide), enforced by
`user_roles_scope_check`. A unique index prevents the same role being granted
twice in the same scope.

### Authorization helpers (`openiwatch` schema)

`SECURITY DEFINER` and read-only, so RLS policies on `user_roles` do not recurse
when another table's policy asks what roles a user holds.

| Function | Answers |
| --- | --- |
| `is_super_admin()` | Platform-wide administrator? |
| `has_org_role(org, roles[])` | Holds any of these roles in this organization? |
| `is_org_member(org)` | Member of this organization? |
| `is_program_member(program)` | Explicit program member, or an org-level admin/manager? |
| `can_validate(org)` | May validate candidates — analyst or program admin only |
| `can_operate(org)` | May acknowledge, assign, escalate, resolve, dispose |
| `can_administer(org)` | May change administration settings |

---

## Protected locations

### `locations`
Warehouse number (text — client numbers are not integers, e.g. `01147`),
official name, full address, city, county, state, ZIP, country, latitude,
longitude, time zone, `nearby_landmarks[]`, `store_features[]`, notes, active
flag.

`geocode_source` records how coordinates were obtained. Phase 1 uses
`seeded_approximate` — accurate enough for vicinity matching, and no paid
geocoding service is required. Swapping in a provider updates only these
columns.

Unique on `(program_id, facility_number)`.

### `location_aliases`
Alternate names the public actually uses (`Mt. Vernon` for Costco #1115,
`Costco Carrollton` for #01147). Drives alias-based matching. Trigram-indexed.

### `operational_assignments`
Assignment label, sequence number, coverage notes, active flag. Unique on
`(program_id, assignment_number)` and `(program_id, name)`.

### `location_geofences`
Circular zones per location — property (200 m), parking (400 m), vicinity
(1600 m). Used for coordinate-proximity matching. Polygon support is additive.

### `location_contacts`
Client-side contacts (store manager, regional manager, on-site security) with a
`notify_order`. Used to record who the SOC notified.

---

## Collection and signals

### `integrations`
One row per connector, carrying its honest `status`: `implemented`,
`simulated`, `stubbed`, `requires_credentials`, `requires_vendor_documentation`.
`config` holds non-secret configuration only — credentials always come from
environment variables read server-side.

### `collection_sources`
A named source under an integration, with an opaque incremental `cursor`.

### `signal_authors`
Public author information exactly as the source published it: handle, display
name, `profile_location_text`, profile URL, description,
`source_profile_metadata`. Unique on `(organization, platform, handle)`.

> `profile_location_text` is a **self-declared string**. It is never the
> author's current location and the application never renders it as one.

### `signals`
The raw collected item. Every signal preserves:

| Column | |
| --- | --- |
| `source_platform` | Platform label |
| `source_record_id` | Identifier assigned by the source |
| `source_url` | Link to the original |
| `original_text` | Verbatim |
| `published_at` | The source's own timestamp, never adjusted |
| `ingested_at` | When OpeniWatch collected it |
| `author_id` | Public author record |
| `collection_method` | `manual_submission`, `webhook`, `connector_pull`, `simulator` |
| `provenance` | Chain of custody, in plain language |
| `content_hash` | SHA-256 over normalized text plus platform |
| `raw_payload` | The source payload, verbatim |
| `source_latitude` / `source_longitude` / `has_public_geotag` | Source-supplied coordinates |
| `is_retention_restricted` | Marks signals under a restricted retention policy |

Unique on `(organization_id, source_platform, source_record_id)` — this is the
idempotency guarantee that makes webhook retries safe.

**There is no UPDATE policy on `signals`.** Original evidence is immutable to
every application role.

### `signal_media`
External media references. URLs are stored, validated on render and opened with
`noopener noreferrer nofollow`. Phase 1 never re-hosts or proxies source media.

### `signal_location_matches`
Which protected location a signal concerns, with `method`, `confidence` (0–100),
`evidence[]` in plain language, `distance_meters`, `is_primary` and
`assessed_by` (`automated` | `analyst` | `soc`).

### `signal_duplicates`
Links between signals with `similarity` and `method` (`content_hash`,
`near_duplicate_text`, `shared_media`, `analyst_marked`).

---

## Alert operations

### `threat_categories`
The taxonomy: key, label, group, baseline severity, severity weight,
description, active flag. Administrators may add categories or deactivate them,
and nothing in the application treats the list as closed.

### `candidate_alerts`
A signal that may represent a threat. One per signal (unique on `signal_id`).

Two assessments are kept strictly apart:

| Automated (immutable) | Analyst (nullable) |
| --- | --- |
| `automated_category_key` | `analyst_category_key` |
| `automated_severity` | `analyst_severity` |
| `automated_priority_score` | |
| `automated_score` (jsonb: all seven sub-scores and factors) | `analyst_notes` |
| `automated_explanation` | |
| `scorer_id` | |

The `candidate_alerts_protect_automated` trigger rejects any update that changes
an `automated_*` column.

Incident location: `incident_location_confidence`, `_method`, `_evidence[]`,
`_assessed_by`.

Author current location: `author_location_status` (default `unknown`),
`_stated`, `_confidence`, `_evidence` (jsonb), `_assessed_by`. The
`candidate_author_location_requires_evidence` CHECK constraint permits a
non-`unknown` status only when the evidence array is non-empty.

Status: `pending_review`, `under_review`, `validated`, `rejected`, `duplicate`,
`suppressed`.

### `alerts`
A validated candidate, approved for operational distribution. An alert that has
been acknowledged, assigned or escalated is the operational **incident**.

Lifecycle timestamps drive every latency metric in reporting: `published_at`,
`detected_at`, `validated_at`, `first_notified_at`, `acknowledged_at`,
`assigned_at`, `escalated_at`, `resolved_at`, `closed_at`.

Status: `open`, `acknowledged`, `assigned`, `escalated`, `monitoring`,
`resolved`, `closed`. Severity: `critical`, `high`, `moderate`,
`informational`. Disposition: `confirmed`, `credible_unconfirmed`,
`unconfirmed`, `false_positive`, `duplicate`, `outdated`, `wrong_location`,
`non_operational`, `resolved`.

`spyglass_reference` holds an optional deep link into the Spyglass layer.

The `alerts_guard_lifecycle` trigger enforces, regardless of client:

- an alert cannot be resolved or closed without being acknowledged;
- an alert cannot be closed without a final disposition;
- candidate, signal and validation provenance are immutable after creation.

### SOC records

| Table | Contents |
| --- | --- |
| `alert_evidence` | Source item, media, corroborating signals, analyst attachments, external links |
| `alert_assignments` | Assignment history with who assigned to whom, and why |
| `alert_acknowledgments` | Who acknowledged, on which channel, with `response_seconds` |
| `alert_escalations` | Level, reason, `notified_parties[]`, `store_manager_notified`, `regional_manager_notified` |
| `alert_dispositions` | Disposition, rationale, and `assessed_by` distinguishing an analyst assessment from a SOC decision |
| `alert_comments` | `operational_note`, `analyst_note` or `system` |

### `notification_subscriptions`
Scope narrows left to right: organization → program → location → assignment. A
null at any level means "everything within the enclosing scope". Empty
`severities[]` or `category_keys[]` means "all". `channels[]` must be non-empty.
Quiet hours are advisory; critical alerts always deliver.

### `notification_deliveries`
One row per attempt: channel, status (`pending`, `sent`, `delivered`, `failed`,
`skipped`, `simulated`), `provider_id`, `path_step`, `attempted_at`,
`delivered_at`, `acknowledged_at`, `detail`, `is_simulated`, `read_at`.

`is_simulated` is true when no live provider credentials were configured and the
delivery was recorded rather than sent.

### `audit_events`
Append-only. Organization, actor and actor role, action, entity type and id, a
jsonb detail snapshot, and `occurred_at`.

Immutability is enforced twice: the `audit_events_immutable` trigger raises on
any UPDATE or DELETE, and no RLS policy for UPDATE or DELETE exists.

---

## Administration

### `scoring_thresholds`
Severity bands over the 0–100 priority score (`critical_min`, `high_min`,
`moderate_min`), `auto_suppress_below`, `minimum_location_confidence`, and
`scorer_id` — which selects the scoring implementation. Constrained so the bands
descend.

### `escalation_rules`
Per severity: `unacknowledged_seconds`, `escalate_to`, and an ordered
`channel_path[]`. A unique index allows one rule per severity per program plus
one organization-wide default.

### `ingest_rate_limits`
Fixed-window counters for the ingest endpoint. RLS is enabled with **no
policies**, so only the service role can touch it.

---

## Enums

| Enum | Values |
| --- | --- |
| `app_role` | super_admin, program_admin, analyst, soc_manager, soc_operator, viewer |
| `candidate_status` | pending_review, under_review, validated, rejected, duplicate, suppressed |
| `alert_status` | open, acknowledged, assigned, escalated, monitoring, resolved, closed |
| `severity_level` | critical, high, moderate, informational |
| `alert_disposition_value` | confirmed, credible_unconfirmed, unconfirmed, false_positive, duplicate, outdated, wrong_location, non_operational, resolved |
| `author_location_status` | unknown, unconfirmed, reported_by_author, geotagged, visually_corroborated, corroborated_by_source |
| `author_location_evidence_kind` | public_geotag, coordinates_in_source, contemporaneous_statement, visual_evidence, other_public_source |
| `location_match_method` | explicit_geotag, coordinate_proximity, store_number_mention, address_mention, alias_mention, landmark_and_city, city_and_brand, analyst_assigned |
| `collection_method` | manual_submission, webhook, connector_pull, simulator |
| `delivery_channel` | in_app, web_push, sms, email, microsoft_teams, webhook |
| `delivery_status` | pending, sent, delivered, failed, skipped, simulated |
| `escalation_level` | soc_supervisor, program_manager, client_regional, client_executive |
| `assessment_source` | automated, analyst, soc |
| `connector_kind` | zignal, rss, public_safety, manual, generic_webhook, simulator |
| `integration_status` | implemented, simulated, stubbed, requires_credentials, requires_vendor_documentation |
| `geocode_source` | seeded_approximate, geocoding_service, manual, ungeocoded |

---

## Privileges

RLS decides which rows a role may touch; table privileges decide whether it may
touch the table at all. Both are required — a policy has no effect if the
privilege is missing.

Migration `0009` grants `authenticated` and `service_role` broad DML on
`public`, then revokes what must never be possible for any application role:

| Revoked | From | Why |
| --- | --- | --- |
| `UPDATE` | `signals` | Collected evidence is immutable |
| `UPDATE`, `DELETE` | `audit_events` | The audit trail is append-only |
| `DELETE` | `alerts`, `candidate_alerts`, and the alert child tables | The operational record is never destroyed; use `closed` and a disposition |
| everything | `ingest_rate_limits` | Service role only |

`anon` receives no table privileges at all: OpeniWatch has no unauthenticated
surface.

`supabase/tests/rls_scenarios.sql` verifies each of these against a real
PostgreSQL instance. Run it with `npm run test:rls`.

---

## Realtime

`alerts`, `candidate_alerts`, `notification_deliveries` and
`alert_acknowledgments` are added to the `supabase_realtime` publication.
Realtime respects RLS, so a subscriber receives only rows it is allowed to read.
