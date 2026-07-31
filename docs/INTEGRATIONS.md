# Integrations

Every integration is listed under exactly one status. Nothing here is described
as working unless it works.

| Status | Meaning |
| --- | --- |
| **Implemented and verified** | Built and proven to work by an executed test. |
| **Implemented but not verified** | Built, but never executed against live infrastructure. |
| **Simulated** | Works, but produces generated data clearly labelled as such. |
| **Stubbed** | Interface exists; no behaviour behind it. |
| **Disabled** | Deliberately switched off; no request is attempted. |
| **Requires credentials** | Built or partially built; inert until credentials are supplied. |
| **Requires vendor documentation** | Cannot be completed without information we do not have. |

The authoritative per-integration status table is in
[`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md), which also records exactly
why an item is unverified.

The Administration → Integrations screen shows the same statuses at runtime, so
an operator never has to read this file to find out what works.

---

## Collection connectors

All implement the `Connector` interface: `testConnection`, `pullSignals`,
`normalizeSignal`, `getCursor`, `saveCursor`, `handleWebhook`, `healthCheck`.

### Manual analyst submission — **Implemented and verified**

An analyst enters a public source or operational report through the form on the
Simulator screen. The submission runs through the same validation,
normalization, matching, duplicate detection and scoring as any other signal.

Restricted to analysts and program administrators, in the interface and in the
RLS policy on `signals` INSERT (which additionally requires
`collection_method = 'manual_submission'`, so this route cannot be used to
fabricate connector-collected evidence).

### Secure ingest webhook — **Implemented but not verified**

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

### In-app — **Implemented and verified**

The delivery record *is* the notification. The app reads
`notification_deliveries` for the signed-in user, and Supabase Realtime pushes
new rows to open sessions. Always available; always included in the channel
path so a critical alert cannot be configured into silence inside the
application.

### Development provider — **Implemented and verified** (records simulated deliveries)

Handles any channel with no live provider. Produces a delivery row with status
`simulated`, `is_simulated = true` and a note saying no live provider is
configured. This is what makes the full workflow demonstrable without OneSignal
or Twilio, without ever claiming a message was sent.

### OneSignal web push — **Implemented but not verified**

Now complete: the `dispatch-notifications` Edge Function performs the REST call
server-side, the browser opt-in flow is built, the service worker is committed,
and the CSP allows the SDK and API. Deliveries move `queued` → `sent`, and
provider acceptance is never recorded as `delivered`.

Never executed against a real OneSignal application — this environment has no
route to `onesignal.com`. Full setup and verification steps in
[`ONESIGNAL_SETUP.md`](ONESIGNAL_SETUP.md).

**Requires** `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY` (Supabase function
secrets) and `VITE_ONESIGNAL_APP_ID` (Netlify).

### Twilio SMS — **Disabled**

The critical-path SMS fallback. **No Twilio request is attempted in any code
path**, and attempts are recorded as `disabled` with the reason — never as
`simulated` or `sent`, because nothing was sent and nothing should pretend to
have been.

`OPENIWATCH_ENABLE_SMS` must be exactly `"true"` before the gate even opens, and
even then this phase does not send: the flag alone must not start messaging real
phones.

**Prerequisites for a later controlled SMS pilot**, all of which must be in
place before the switch is flipped:

1. **Consent capture** — recorded, per recipient, with a timestamp and the
   wording they agreed to. Alerting someone's personal phone is not covered by
   an employment relationship alone.
2. **Recipient verification** — each number confirmed by a one-time code, so a
   typo cannot page a member of the public. Store the verification timestamp.
3. **Opt-out handling** — STOP/UNSTOP processed automatically and honoured
   immediately, with the opt-out recorded against the profile. This is a legal
   requirement in most jurisdictions, not a courtesy.
4. **Rate limits and cost ceilings** — a per-hour and per-day cap per recipient
   and per organization, so a scoring regression cannot generate a bill or a
   barrage.
5. **Escalation governance** — written agreement on who may be paged by SMS, at
   what severity, and in which hours; plus who may enable the channel. SMS is the
   most intrusive channel and needs the narrowest authorization.
6. **Quiet-hours policy** — an explicit decision on whether critical alerts
   override quiet hours, agreed with the client rather than assumed.
7. **A tested kill switch** — the outbound switch already exists; it must be
   exercised before SMS is enabled, not after.
8. **Twilio account configuration** — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_FROM_NUMBER`, a messaging service, and A2P 10DLC registration for US
   numbers.

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
| Manual analyst submission | Implemented and verified | — |
| Secure ingest webhook | Implemented but not verified | A deployed Supabase project |
| Development simulator | Simulated | — |
| In-app notifications | Implemented and verified | — |
| Development notification provider | Implemented and verified | — |
| OneSignal web push | Implemented but not verified | OneSignal credentials |
| Twilio SMS | Disabled | The eight prerequisites above |
| Automatic escalation | Implemented but not verified | A deployed function and a schedule |
| Data retention | Implemented but not verified | A deployed project |
| Email | Stubbed | Email service |
| Microsoft Teams | Stubbed | Webhook URL + dispatcher |
| Outbound webhook | Stubbed | URL + signing secret |
| RSS / news | Requires credentials | Feed URLs + server-side polling |
| Public safety feed | Requires credentials | Agency endpoint, key and permission |
| Zignal / Spyglass collection | Requires vendor documentation | The ten items listed above |
| Spyglass deep linking | Implemented | `VITE_SPYGLASS_BASE_URL` |
