# Browser configuration

Every variable the browser reads, what happens when one is missing, and why the
answer is "refuse to start" rather than "show something".

---

## The failure this prevents

A deployed OpeniWatch displayed:

> Local demo mode. No Supabase credentials are configured.

on a real staging site. It looked like a working security operations tool. It
was backed by records held in one browser tab, visible to nobody else, gone the
moment storage was cleared. An operator could have acknowledged an alert and
believed a location was being watched.

That is the worst failure this product has, and it was caused by one line:

```ts
export const dataMode: DataMode = isSupabaseConfigured ? 'supabase' : 'local-demo'
```

Missing variables meant demo mode. Silently, everywhere, including production.

**It now fails closed.** Outside local development, missing configuration
produces a blocking screen and no data provider is constructed at all.

---

## Variables

All are compiled into the JavaScript bundle at **build** time. Setting them in a
hosting dashboard does nothing until the site is **rebuilt and redeployed** —
they are not read when the page loads.

Every name must keep its `VITE_` prefix. A name without it is invisible to the
browser build by design.

| Variable | Required | Meaning |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | **Yes**, in any deployment | Supabase project URL. Must parse as an absolute http(s) URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | **Yes**, in any deployment | Supabase publishable key |
| `VITE_ENVIRONMENT_LABEL` | Recommended | `Staging` or `Production` switch on fail-closed handling. Shown as a compact header badge |
| `VITE_ENABLE_LOCAL_DEMO` | No | `true` permits browser-local demo data. **Ignored in staging and production** |
| `VITE_ENABLE_SIMULATOR` | No | `true` enables the signal simulator. **Never honoured in production** |
| `VITE_ONESIGNAL_APP_ID` | No | Web push. Public by design |
| `VITE_DEFAULT_ORG_NAME` | No | Display name for the seeded organization |
| `VITE_SPYGLASS_BASE_URL` | No | Enables "View in Spyglass" deep links |
| `VITE_ENABLE_SMS` | No | Mirrors the server flag so the interface can say why SMS is off. Does not enable sending |

### Never given a VITE_ prefix

These are server-side only. A `VITE_` alias for any of them would inline the
secret into a file anyone can download:

```
SUPABASE_SECRET_KEY   SUPABASE_ACCESS_TOKEN   SUPABASE_DB_PASSWORD
ONESIGNAL_REST_API_KEY      OPENIWATCH_INGEST_SECRET   NETLIFY_AUTH_TOKEN
TWILIO_AUTH_TOKEN           ZIGNAL_API_KEY
```

Three tests enforce this: browser code never reads one of these names through
`import.meta.env`; `src/vite-env.d.ts` declares no `VITE_` alias for one; and a
built bundle is scanned for all of them.

---

## The rules

`resolveConfiguration()` in `src/lib/env.ts`, applied in order:

1. **URL and key both present and usable → Supabase.** True in every
   environment, so a correctly configured build never depends on any flag.
2. **Otherwise, staging or production → BLOCKED.** The demo provider is never
   substituted for a real backend in a deployed environment, whatever
   `VITE_ENABLE_LOCAL_DEMO` says.
3. **Otherwise, development, and `VITE_ENABLE_LOCAL_DEMO=true` → demo.**
4. **Otherwise → BLOCKED.**

`Staging`, `staging`, `stage`, `Production`, `prod` are all recognised, case and
whitespace insensitive. Anything else — including a typo — is treated as
development, so a developer is never locked out by one and an unrecognised label
never silently claims production's guarantees.

A present but unparseable `VITE_SUPABASE_URL` is a configuration failure, not a
value to hand to the Supabase client and let fail later.

### The blocking screen

Shows: which variable **names** are absent or unusable, that these are
build-time values needing a redeploy, the `VITE_` prefix rule, and a reference
code such as `OW-CFG-STG-UK`.

Shows, and can show, **no value** — not a fragment, not a length, not a hash,
not an encoding. It renders before authentication, so anyone can reach it. The
reference code is derived only from which names are missing and is safe to
quote in a ticket or a screenshot.

Behind it: no data provider, no seeded records, no session, no navigation, and
no service worker registration.

---

## Local development

`npm run dev` works from a fresh clone with no credentials. Vite loads
`.env.development`, which is committed and contains only:

```
VITE_ENABLE_LOCAL_DEMO=true
VITE_ENABLE_SIMULATOR=true
```

A production build uses mode `production` and never reads that file, so nothing
in it can reach a deployment.

Playwright's build command sets both explicitly, for the same reason.

---

## Simulator

Three conditions, all required:

1. the environment is **not** production — refused unconditionally there, flag
   or no flag, because the simulator writes signals into the operational
   database;
2. `VITE_ENABLE_SIMULATOR` is exactly `true`;
3. the signed-in role may submit signals (analyst, program administrator).

Enforced in the navigation, at the route (so typing the URL gets the same
answer), and by RLS at the database.

**Demo mode does not grant simulator access.** Previously the flag defaulted to
`true`, so a deployment had to remember to switch it off. It now defaults to off
and must be asked for.

> The production rule is a hard refusal, not a default that can be overridden.
> If a production deployment ever genuinely needs the simulator, that is a
> deliberate change to `isSimulatorAvailable()` and should be argued for on its
> own merits.

---

## Netlify

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<anon key>
VITE_ENVIRONMENT_LABEL=Staging
VITE_ENABLE_SIMULATOR=false
VITE_ENABLE_LOCAL_DEMO=false
VITE_ONESIGNAL_APP_ID=<app id>          # optional
VITE_DEFAULT_ORG_NAME=<organization>    # optional
```

Then **trigger a redeploy** — "Clear cache and deploy site". Saving variables
alone changes nothing, because the previous bundle already has the old values
compiled in. This is the single most likely cause of a site still showing demo
mode after the variables look correct in the dashboard.

Never set a server-side secret in Netlify. Those belong to Supabase function
secrets.

---

## Tests

`src/lib/env.test.ts` — 24 unit tests covering all seven required cases.

`e2e/configuration.spec.ts` — 9 tests that build the application for real with
`vite build` and serve the output, so the rules are proven to survive
compilation rather than only holding in source.
