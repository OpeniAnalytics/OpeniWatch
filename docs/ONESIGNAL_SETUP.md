# OneSignal web push

**Status: implemented but not verified.** Every piece of code is complete. It
has never run against a real OneSignal application, because this environment
has no network route to `onesignal.com` and no credentials.

## Design rules

1. **The REST API key never reaches the browser.** All sending happens in the
   `dispatch-notifications` Edge Function. The browser bundle contains only
   `VITE_ONESIGNAL_APP_ID`, which is public by design.
2. **Registration is explicitly opt-in.** OpeniWatch never calls
   `Notification.requestPermission()` on load, and the OneSignal SDK is not
   downloaded until an operator presses the button. A permission prompt nobody
   asked for is how a channel gets blocked permanently.
3. **Minimum data.** `push_subscriptions` holds the provider's opaque
   subscription id, the OpeniWatch user id, and a coarse device label such as
   "Chrome on Windows". No fingerprint, no location, no advertising id.
4. **Provider acceptance is not delivery.** OneSignal's response says it
   accepted the notification and how many recipients matched. That is recorded
   as `sent`. `delivered` is reserved for a confirmed device receipt, which
   requires a callback OpeniWatch does not yet receive.
5. **The push preview carries no source content.** It shows severity and the
   location label only. It appears on a lock screen, so it must not carry the
   report text, the public author handle, or anything identifying.

## Setup

1. Create an app at <https://onesignal.com>, platform **Web**.
2. Site URL: the staging Netlify URL. Enable **Typical Site** integration.
3. Note the **App ID** and create a **REST API key**.

4. Supabase function secrets (server-side only):

   ```bash
   supabase secrets set ONESIGNAL_APP_ID=<app-id>
   supabase secrets set ONESIGNAL_REST_API_KEY=<rest-api-key>
   supabase secrets set OPENIWATCH_APP_ORIGIN=https://<staging-site>
   supabase functions deploy dispatch-notifications
   ```

5. Netlify environment (browser-safe):

   ```
   VITE_ONESIGNAL_APP_ID=<app-id>
   ```

   **Never set `ONESIGNAL_REST_API_KEY` in Netlify.**

6. The service worker at `public/OneSignalSDKWorker.js` is copied into the build
   and served from the site root. `netlify.toml` sets
   `Service-Worker-Allowed: /` so the root scope is granted.

## Routing

A push is sent to a user when a validated alert matches one of their
notification subscriptions and that subscription includes the `web_push`
channel. Subscriptions scope by program, location, operational assignment,
severity and threat category — scope narrows left to right, and a null at any
level means "everything within".

The channel path per severity comes from `escalation_rules.channel_path`;
critical is in-app → web push → SMS. In-app is always included, so a critical
alert cannot be configured into silence inside the application.

## Delivery statuses

| Status | Meaning |
| --- | --- |
| `queued` | Accepted by OpeniWatch, waiting for the dispatcher |
| `pending` | Claimed by the dispatcher, provider call in flight |
| `sent` | OneSignal accepted it. **Not proof of device delivery** |
| `delivered` | Confirmed device receipt. Not currently reachable for web push |
| `failed` | Rejected, unreachable, or accepted with zero recipients |
| `skipped` | No registration, or OneSignal not configured |
| `disabled` | Kill switch on, or the channel is switched off |
| `simulated` | Recorded only; no live provider was configured |

Duplicate sends are prevented twice: the dispatcher claims a row out of `queued`
before calling the provider, so concurrent runs find nothing; and
`notification_deliveries.dedupe_key` has a unique index.

## Disabling

- **One user, one device:** remove the registration in the interface. It calls
  `optOut()` at the provider and deletes the row.
- **Whole organization:** the outbound kill switch in Administration. In-app
  delivery continues; web push and SMS record `disabled` with the reason.

## Verification, once credentials exist

```bash
npm run validate:staging
```

Then manually:

1. Sign in to staging as the SOC manager, opt in to web push, confirm a row in
   `push_subscriptions`.
2. Validate a candidate as the analyst.
3. Run the dispatcher:
   `curl -X POST "$SUPABASE_URL/functions/v1/dispatch-notifications" -H "x-openiwatch-secret: $OPENIWATCH_INGEST_SECRET" -d '{}'`
4. Confirm the browser notification arrives and opens the correct alert.
5. Confirm `notification_deliveries` shows `sent` with a `provider_message_id`
   and a `provider_response`, and that `delivered_at` is null.
6. Re-run the dispatcher and confirm no second notification.
