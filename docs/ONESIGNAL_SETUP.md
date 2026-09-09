# OneSignal web push

**Status: implemented, verified locally, not verified against OneSignal.**

The dashboard setup is complete and the App ID and REST API key exist in the
secure environment. Every code path is written and unit-tested, and the served
worker files are verified against a real production build. Nothing has been
exercised against the live OneSignal service, because this environment still
has no network route to `onesignal.com` and no Supabase or Netlify deployment
to register a subscription from.

No notification has been sent. No device has opted in. Nothing below describes
an observed delivery.

---

## Design rules

1. **The REST API key never reaches the browser.** All sending happens in the
   `dispatch-notifications` Edge Function. The browser bundle contains only
   `VITE_ONESIGNAL_APP_ID`, which is public by design. Three tests enforce this:
   the key is never read from `import.meta.env`, it has no `VITE_` alias, and a
   built bundle is scanned for it.
2. **The SDK initializes exactly once.** `PushClient.ready()` memoizes one
   `init()` promise, so concurrent callers share it and a second call is a no-op.
   There is no OneSignal snippet in `index.html` — adding one would produce a
   second initialization.
3. **Registration is explicitly opt-in.** OpeniWatch never calls
   `Notification.requestPermission()` on load, and the SDK is not downloaded
   until an operator presses the button. A permission prompt nobody asked for is
   how a channel gets blocked permanently.
4. **Identity follows the Supabase session.** `login(user.id)` on sign-in and
   session restore, `logout()` on sign-out.
5. **Minimum data.** `push_subscriptions` holds the provider's opaque
   subscription id, the OpeniWatch user id, and a coarse device label such as
   "Chrome on Windows". No fingerprint, no location, no advertising id.
6. **Provider acceptance is not delivery.** OneSignal's response says it
   accepted the notification and how many recipients matched. That is recorded
   as `sent`. `delivered` is reserved for a confirmed device receipt, which
   requires a callback OpeniWatch does not yet receive.
7. **The push preview carries no source content.** Severity and location label
   only. It appears on a lock screen, so it must not carry the report text, the
   public author handle, or anything identifying.

---

## Two service workers, separated by scope

This is the arrangement, and the reasoning matters because getting it wrong
breaks either push or installability with no obvious symptom.

| File | Scope | Registered by | Contents |
| --- | --- | --- | --- |
| `/sw.js` | `/` | `src/services/pwa/register.ts` on startup | Offline shell, install support |
| `/OneSignalSDKWorker.js` | `/onesignal/` | The OneSignal SDK, on opt-in | Vendor file, verbatim |

A scope may have exactly one active service worker registration. Both workers
want to live on the same origin, so they are separated by **scope** rather than
by merging their code into one file.

**Why a narrow scope is safe for push:** a push subscription belongs to a
service worker *registration*, not to a page. Push events and notification
clicks are delivered to OneSignal's worker whether or not any page falls inside
its scope. This is OneSignal's own documented arrangement for a site that
already has a service worker.

**`public/OneSignalSDKWorker.js` must stay byte-for-byte as OneSignal supplies
it:**

```js
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
```

One line, 75 bytes. A test asserts this and fails on anything else. An earlier
revision of this repository merged the offline shell into that file; it worked
in principle but left a vendor file that OneSignal support could not reason
about, and any future edit to the shell risked silently breaking push. The
files are now separate.

`netlify.toml` gives both workers `Service-Worker-Allowed: /`, `no-cache`, an
explicit JavaScript content type, and an explicit passthrough redirect so the
SPA fallback cannot rewrite either one to `index.html`. A worker served as HTML
fails to register, and the symptom reads as "push does not work".

---

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

   **Never set `ONESIGNAL_REST_API_KEY` in Netlify.** Then trigger a redeploy —
   `VITE_` values are compiled into the bundle at build time, so saving the
   variable alone changes nothing.

6. Both worker files are copied from `public/` into the build root
   automatically. No dashboard configuration references them beyond the site
   URL.

---

## Identity and shared devices

OpeniWatch is used on phones that get handed over between shifts, so identity
is managed explicitly rather than left to whatever the SDK remembers.

| Event | What happens |
| --- | --- |
| Sign-in / session restore | `login(user.id)` — but only on a device that has already enrolled. On a device that never opted in this is a no-op, so an operator who never asked for push never causes a request to OneSignal. |
| Opt-in | `requestPermission()` → `optIn()` → `login(user.id)` → store the subscription row. The identity is claimed before the id is read, so the subscription belongs to that operator from the moment it exists. |
| Different operator signs in | `login(newUser.id)` moves the device to them. The previous operator's alerts stop arriving on a phone they no longer hold. |
| Sign-out | `logout()` detaches the device, before the session is cleared. |
| Opt-out | `optOut()` **and** `logout()` **and** the row is deleted. |

**A user cannot associate a subscription with another OpeniWatch user.** The
RLS policy `push_subscriptions_own` has
`with check (user_id = auth.uid() and is_org_member(organization_id))`, so the
database rejects a row naming anyone else regardless of what the client sends.
The client-side identity handling above is about correct *delivery*; the policy
is the boundary.

### Subscription id rotation

A browser can reissue its push endpoint at any time. `onSubscriptionChange`
watches for it and re-registers the row, so a stored id cannot quietly stop
matching the live subscription — which would otherwise produce deliveries that
OneSignal accepts and that reach nobody.

---

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

---

## Routing

A push is sent to a user when a validated alert matches one of their
notification subscriptions and that subscription includes the `web_push`
channel. Subscriptions scope by program, location, operational assignment,
severity and threat category — scope narrows left to right, and a null at any
level means "everything within".

The channel path per severity comes from `escalation_rules.channel_path`;
critical is in-app → web push → SMS. In-app is always included, so a critical
alert cannot be configured into silence inside the application.

---

## Disabling

- **One user, one device:** *Notifications → Web push → Turn off*. This calls
  `optOut()` and `logout()` at the provider and deletes the row.
- **Whole organization:** the outbound kill switch in Administration. In-app
  delivery continues; web push and SMS record `disabled` with the reason.

---

## What has been verified, and what has not

**Verified locally, by executed tests:**

- the SDK initializes exactly once across opt-in, identity sync and opt-out,
  including under concurrent callers;
- the App ID passed to `init()` comes from the injected environment, never a
  literal, and the worker path and scope are what this document states;
- a missing App ID reports push unavailable, names the variable, and never
  loads the SDK;
- opt-in requests permission, subscribes, associates the user, and records
  nothing when permission is refused or no subscription id is returned;
- sign-in and session restore associate the enrolled device, and do nothing on
  a device that never enrolled;
- a second operator signing in moves the device to them;
- sign-out detaches at the provider;
- opt-out calls the provider *and* clears local enrollment;
- a rotated subscription id is reported so the row can be corrected;
- the REST API key is absent from `src/`, from `vite-env.d.ts`, from
  `.env.example` and from the built bundle;
- `public/OneSignalSDKWorker.js` is byte-identical to the vendor file, is
  copied unmodified to `/OneSignalSDKWorker.js` by the build, and is served
  200, unauthenticated, with no redirect, as JavaScript, from the application
  origin.

**Not verified — requires a deployment and network access:**

- that OneSignal accepts this App ID and registers a subscription;
- that a notification is accepted by OneSignal and arrives on a device;
- that the narrow `/onesignal/` scope behaves as expected against the live SDK;
- that `login()` / `logout()` produce the external-id association OneSignal's
  dashboard shows;
- that both service workers coexist on a real deployed origin.

The commands for all of that are in
[`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md). Once a deployment exists:

```bash
npm run validate:staging
```

Then manually:

1. Sign in to staging as the SOC manager, open **Notifications**, press
   **Enable web push on this device**, confirm a row in `push_subscriptions`
   and an external id on the OneSignal user.
2. Validate a candidate as the analyst.
3. Run the dispatcher:
   `curl -X POST "$SUPABASE_URL/functions/v1/dispatch-notifications" -H "x-openiwatch-secret: $OPENIWATCH_INGEST_SECRET" -d '{}'`
4. Confirm the browser notification arrives and opens the correct alert.
5. Confirm `notification_deliveries` shows `sent` with a `provider_message_id`
   and a `provider_response`, and that `delivered_at` is null.
6. Re-run the dispatcher and confirm no second notification.
7. Sign out, sign in as a different operator, and confirm the OneSignal user's
   external id changes — this is the shared-device check.
