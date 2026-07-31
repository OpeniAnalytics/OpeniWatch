# Integrations

Every integration is listed under exactly one status. Nothing here is described
as working unless it works.

| Status | Meaning |
| --- | --- |
| **Implemented** | Built, tested, works now. |
| **Simulated** | Works, but produces generated data clearly labelled as such. |
| **Stubbed** | Interface exists; no behaviour behind it. |
| **Requires credentials** | Built or partially built; inert until credentials are supplied. |
| **Requires vendor documentation** | Cannot be completed without information we do not have. |

The Administration → Integrations screen shows the same statuses at runtime, so
an operator never has to read this file to find out what works.

---

## Collection connectors

All implement the `Connector` interface: `testConnection`, `pullSignals`,
`normalizeSignal`, `getCursor`, `saveCursor`, `handleWebhook`, `healthCheck`.

### Manual analyst submission — **Implemented**

An analyst enters a public source or operational report through the form on the
Simulator screen. The submission runs through the same validation,
normalization, matching, duplicate detection and scoring as any other signal.

Restricted to analysts and program administrators, in the interface and in the
RLS policy on `signals` INSERT (which additionally requires
`collection_method = 'manual_submission'`, so this route cannot be used to
fabricate connector-collected evidence).

### Secure ingest webhook — **Implemented**

```
POST /functions/v1/ingest-signal
x-openiwatch-secret: <OPENIWATCH_INGEST_SECRET>
content-type: application/json

{ "signals": [ { ... } ], "batchId": "optional-caller-reference" }
```

- Shared-secret authentication, compared in constant time.
- Rate limited (120 requests per minute per caller by default), counted in the
  database so the limit survives cold starts and applies across instances.
- Every payload validated against the shared schema before any write.
- Idempotent: a retried delivery of the same source record creates nothing new
  and still returns 200, counted as a duplicate.
- Content-hashed for duplicate detection.
- An audit event per batch.
- The target program comes from `OPENIWATCH_INGEST_PROGRAM_SLUG`, **not** from
  the payload, so a caller cannot write into a program its secret was not issued
  for.

Response:

```json
{
  "accepted": 2, "duplicates": 1, "failed": 0, "batchId": "...",
  "acceptedRecords": [{ "sourceRecordId": "...", "signalId": "..." }],
  "duplicateRecords": ["..."], "failedRecords": []
}
```

**Requires** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
`OPENIWATCH_INGEST_SECRET` set as function secrets. Generate the secret with
`openssl rand -hex 32`.

### Development simulator — **Simulated**

Eight scenarios against the seeded pilot locations, covering the required
demonstration cases:

1. Critical firearm report in the Stafford parking lot
2. High-severity confrontation inside the Plano warehouse
3. Moderate protest planning near the New Orleans location
4. Informational customer complaint that must not raise an urgent alert
5. Old reposted video that should be dispositioned as outdated
6. Duplicate reports from several accounts — one exact repost, two rewordings
7. Nearby police activity affecting access to the Mansfield location
8. Unconfirmed, hedged suspicious activity near the Allentown location

Every signal is stored with `collection_method = 'simulator'` and a provenance
statement saying it was generated. Handles are fictional (`@demo_*`) and no real
account, person or URL is referenced. Disable in production with
`VITE_ENABLE_SIMULATOR=false`.

### Zignal / Spyglass — **Requires vendor documentation**

Not operational. `testConnection()` returns `ok: false` with the exact list of
what is missing, and the Administration screen shows the same.

**No Zignal endpoint paths are fabricated in this codebase.** `normalizeSignal`
is written against a clearly-marked *hypothetical* record shape purely to show
where vendor field names slot in.

To complete this integration we need, from Zignal:

1. **API base URL** — the documented host and version prefix.
2. **Authentication scheme** — bearer token, API key header, OAuth client
   credentials? Token lifetime and refresh, if any.
3. **Endpoint paths** for listing matched content and retrieving a single item.
4. **Pagination or cursor model** — cursor token, offset, or timestamp
   watermark, and whether results are stable under reordering.
5. **Payload field names** for: item id, full text, author handle, author
   display name, author profile location, author profile URL, published
   timestamp, source URL, media URLs, platform, language, and any geotag or
   coordinate fields.
6. **Query or saved-search model** — how OpeniWatch scopes collection to the
   protected locations, and whether queries are managed via the API or only in
   the Zignal interface.
7. **Rate limits and quotas**, and the expected polling interval.
8. **Terms of use for programmatic collection**, and confirmation that
   redistribution into an operational alerting product is permitted.
9. **Whether push delivery exists** — if so, the payload shape and the signature
   scheme used to verify it.
10. **A sandbox or test account** for integration testing.

With those, the work is: fill in `pullSignals` and `normalizeSignal`, add
cursor persistence to `collection_sources.cursor`, and set the integration
status to `implemented`. The pipeline, storage, scoring and interface do not
change — that is what the connector interface is for.

Environment variables are already reserved: `ZIGNAL_API_BASE_URL`,
`ZIGNAL_API_KEY`.

### RSS / news feeds — **Requires credentials**

`normalizeSignal` maps a standard RSS item onto the shared schema and is ready.
Polling must run server-side and is not enabled in Phase 1.

**Requires** `RSS_FEED_URLS` (comma-separated) and the feed list recorded on the
integration. Only feeds an operator explicitly configures are read — no site is
crawled or scraped.

### Public safety feed — **Requires credentials**

`normalizeSignal` is ready for an incident-shaped record with coordinates.

**Requires** `PUBLIC_SAFETY_FEED_URL`, `PUBLIC_SAFETY_FEED_KEY`, written agency
permission for programmatic access, and documented payload field names.

---

## Notification providers

All implement `NotificationProvider`, which requires each provider to declare
its own `availability()`. The dispatcher never assumes a channel works.

### In-app — **Implemented**

The delivery record *is* the notification. The app reads
`notification_deliveries` for the signed-in user, and Supabase Realtime pushes
new rows to open sessions. Always available; always included in the channel
path so a critical alert cannot be configured into silence inside the
application.

### Development provider — **Implemented (records simulated deliveries)**

Handles any channel with no live provider. Produces a delivery row with status
`simulated`, `is_simulated = true` and a note saying no live provider is
configured. This is what makes the full workflow demonstrable without OneSignal
or Twilio, without ever claiming a message was sent.

### OneSignal web push — **Requires credentials**

Adapter present and behind environment variables. With `VITE_ONESIGNAL_APP_ID`
set, deliveries are queued as `pending` for server-side sending.

**Not yet built:** the server-side dispatcher that performs the REST call.
`ONESIGNAL_REST_API_KEY` is a secret and must never reach the browser, so the
call has to happen in an Edge Function.

**Requires** `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY`,
`VITE_ONESIGNAL_APP_ID`, a OneSignal web-push configuration for the deployed
domain, and the service worker OneSignal requires.

### Twilio SMS — **Stubbed (interface only)**

The critical-path SMS fallback. Deliberately not wired to a live send: a
mis-fired SMS blast during a pilot is worse than a missing one, so this stays a
documented stub until the pilot explicitly enables it. `availability()` returns
false with that reason, and attempts are recorded as `skipped`.

**Requires** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, a
server-side dispatcher, verified recipient numbers on the profile, and
consent/opt-out handling appropriate to the jurisdiction.

### Email — **Stubbed**
Requires an email service and `OPENIWATCH_EMAIL_FROM`.

### Microsoft Teams — **Stubbed**
Requires `MICROSOFT_TEAMS_WEBHOOK_URL` and a server-side dispatcher.

### Outbound webhook — **Stubbed**
Requires `OPENIWATCH_OUTBOUND_WEBHOOK_URL` and a signing secret.

---

## Spyglass linkage

Spyglass remains the strategic brand-intelligence and monitoring layer;
OpeniWatch is the operational action layer.

`alerts.spyglass_reference` holds an optional deep link. When
`VITE_SPYGLASS_BASE_URL` is set, the alert detail view renders a **View in
Spyglass** button; without it, no button appears rather than a dead link.

OpeniWatch does not embed or duplicate the Spyglass dashboard, and does not
require Spyglass to function.

---

## Summary

| Integration | Status | Blocked on |
| --- | --- | --- |
| Manual analyst submission | Implemented | — |
| Secure ingest webhook | Implemented | — |
| Development simulator | Simulated | — |
| In-app notifications | Implemented | — |
| Development notification provider | Implemented | — |
| OneSignal web push | Requires credentials | Credentials + server-side dispatcher |
| Twilio SMS | Stubbed | Credentials + dispatcher + consent handling |
| Email | Stubbed | Email service |
| Microsoft Teams | Stubbed | Webhook URL + dispatcher |
| Outbound webhook | Stubbed | URL + signing secret |
| RSS / news | Requires credentials | Feed URLs + server-side polling |
| Public safety feed | Requires credentials | Agency endpoint, key and permission |
| Zignal / Spyglass collection | Requires vendor documentation | The ten items listed above |
| Spyglass deep linking | Implemented | `VITE_SPYGLASS_BASE_URL` |
