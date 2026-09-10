# Authentication and authorization

**Status: implemented, verified locally, not verified against Microsoft or
Resend.** Every flow is written and unit-tested against a mocked auth client.

The OpeniWatch Supabase project **does** exist — `dbbmlufrefctmxgitosx` — and
its schema is fully migrated and seeded. A previous revision of this document
said no project existed; that was wrong. The project sits in a different
Supabase organization from the one an account-wide listing returned, and the
earlier search concluded from an incomplete list rather than querying the
project reference directly.

What remains unverified is anything requiring a browser against the live
services: no Entra tenant round trip, no Resend delivery, no live magic link.
This environment reaches Supabase and Netlify only through their management
APIs, and has no network route to the deployed site itself.

---

## The model

| | |
| --- | --- |
| **Primary** | Microsoft Entra ID, through Supabase's `azure` provider |
| **Fallback** | Emailed magic link, through Supabase + Resend SMTP |
| **Passwords** | Removed from the sign-in experience entirely |
| **Self-registration** | Not permitted, enforced in two places |

### Why no passwords

A password is the credential most often reused, most often phished, and most
often left behind when someone leaves. A security operations product that can
dispatch an alert about an armed person at a warehouse should not be the place
one survives. Removing it is not only a UX change: `signInWithPassword` is gone
from the provider, and a test fails the build if it returns.

There is deliberately **no password reset flow**, because there is nothing to
reset.

---

## Authentication is not authorization

This is the sentence the whole design turns on.

A successful Microsoft sign-in proves someone controls an account in a
configured Entra tenant. It says nothing about whether they may see a protected
location's alerts. **An entire tenant can authenticate and get nothing.**

After either flow completes, `hydrateSession` requires all three of:

1. a row in `profiles` for the authenticated user;
2. `profiles.is_active = true` — a leaver keeps their Microsoft account, and
   must not keep their OpeniWatch access with it;
3. at least one row in `organization_memberships`.

Any of those missing raises `NotAuthorizedError`, and the application renders
the **Access not authorized** screen instead of the shell. That screen:

- loads no operational data and runs no provider query;
- names no organization, program, location or colleague;
- offers sign-out, so a shared machine is not left holding an unusable session;
- **does not create the missing membership.** Self-provisioning on first
  sign-in would mean anyone in the tenant could grant themselves access by
  visiting the site.

The client-side gate is a second check, not the boundary. Row Level Security is
the boundary and is unchanged by this work — an unauthorized user's reads return
zero rows regardless of what the client does with them.

---

## Flow configuration

Two options on the browser client are load-bearing:

```ts
auth: {
  persistSession: true,
  autoRefreshToken: true,
  detectSessionInUrl: false,
  flowType: 'pkce',
}
```

**`flowType: 'pkce'`.** auth-js defaults to `implicit`, which returns tokens in
the URL fragment. PKCE returns a single-use `code` bound to a verifier held in
this browser, exchanged over a POST. That keeps the access token out of the
address bar, out of history, out of the `Referer` header, and out of any
screenshot pasted into a ticket. **This was changed** — the client previously
took the implicit default.

**`detectSessionInUrl: false`.** With it on, the SDK consumes an auth code the
moment any page loads. OpeniWatch exchanges the code itself so it happens
exactly once, in a place that can report a real error. Two consumers racing for
a single-use credential means the loser reports failure for a sign-in that
worked. This was already correct and is now deliberate rather than incidental.

---

## Routes

| Route | Purpose |
| --- | --- |
| `/auth/callback` | Microsoft returns here. Exchanges `?code=` via `exchangeCodeForSession`. |
| `/auth/confirm` | Magic links return here. Verifies `?token_hash=` via `verifyOtp`, or exchanges `?code=` as a PKCE fallback. |

Both render **outside** the authenticated gate. Routing them through it would
show the sign-in screen over the top of the callback and the credential would
never be exchanged.

Both are served by the SPA fallback and are additionally named in
`netlify.toml`, with `Cache-Control: no-store`.

### Exactly once

Three independent guards:

1. `detectSessionInUrl: false` — the SDK is not a second consumer;
2. a `useRef` claimed synchronously before any `await`, so React's double effect
   invocation in development cannot double-exchange;
3. a module-level set of consumed codes and token hashes. A repeat handling of
   the same credential returns the original success rather than a spurious
   failure.

### URL cleanup

On success **and** on failure, `history.replaceState` rewrites the address to a
clean path with `code`, `token_hash`, `access_token`, `refresh_token`, `state`,
`type` and every error parameter removed, from both the query string and the
fragment.

### Post-login routing

A `next` parameter survives sign-in, so a deep link to an alert still lands in
the right place. It is passed through `safeNext`, which returns `/` for anything
that is not a plain in-app path — absolute URLs, `//evil.example`, `/\evil`,
anything with a scheme or a control character, and `/auth/*` itself. An open
redirect on a sign-in route is how a phishing page gets a real domain in front
of it.

---

## Magic link email template

Supabase can deliver the link in two shapes, and **the template decides which**.
Both are handled, but they are not equally good:

| Template | Link shape | Works cross-browser? |
| --- | --- | --- |
| `{{ .TokenHash }}` — **recommended** | `/auth/confirm?token_hash=…&type=magiclink` | **Yes** |
| `{{ .ConfirmationURL }}` — default | `/auth/confirm?code=…` | **No** |

Under PKCE the code verifier lives in the browser that *requested* the link.
Operators routinely read mail on a phone and work at a desktop, so the default
template will fail for them with "both auth code and code verifier should be
non-empty". The application detects exactly that case and says *"This sign-in
link must be opened in the same browser that requested it"* rather than a
generic failure — but the fix is to configure the token-hash template:

```html
<h2>Sign in to OpeniWatch</h2>
<p>
  <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=magiclink">
    Sign in to OpeniWatch
  </a>
</p>
<p>This link can be used once and expires shortly. If you did not request it, ignore this email.</p>
```

### No address is ever confirmed or denied

`requestMagicLink` returns one fixed sentence whether the address is unknown,
known but unauthorized, authorized, or rate limited. Supabase's real answer
("Signups not allowed for otp") goes to the auth log, where an administrator can
see it and an attacker cannot. Differentiating here would turn the sign-in form
into a directory of who works here.

`shouldCreateUser: false` is what actually closes self-registration: an unknown
address gets no account and no email.

---

## Provisioning an authorized user

`scripts/provision-user.mjs`. **Server-side only** — it uses the project's
secret key, which bypasses RLS entirely, and must never be bundled or placed in
a Netlify variable. The script validates the key against `^sb_secret_` and
refuses to run with anything else, so a legacy `service_role` JWT pasted in by
habit stops at the first line rather than working silently.

```bash
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SECRET_KEY=<sb_secret_...> \
node scripts/provision-user.mjs \
  --email person@company.com \
  --name "Casey Rivera" \
  --role soc_manager \
  --org openi-security-services \
  --program costco-pilot
```

`--dry-run` resolves and prints without writing.

It creates the auth user with `email_confirm: true` and **no password**, then
the profile, organization membership, optional program membership and role.

The decisions live in `scripts/lib/provisionUser.mjs` and talk to a small store
port; `scripts/lib/supabaseStore.mjs` is the Supabase adapter. That split is
what makes the rules testable — a PostgREST chain is close to untestable without
a live database, and these rules are a security boundary.

### It refuses an account that still has a password

Removing the password field from the sign-in screen does not stop Supabase
accepting `grant_type=password`. Provisioning is therefore where an account
carrying a password credential is actually turned away:

```
Refused (password_credential_present):

casey@example.com already has a password credential.
```

Nothing is granted by a refused run — no profile, no membership, no role. The
`--allow-password-credential` flag exists for an operator who has confirmed the
project rejects password grants, and every run that uses it says so in the
output and in the result's `warnings`.

Observing the credential needs help from the database. GoTrue redacts
`encrypted_password` from every Admin API response and `auth.users` is not in
PostgREST's exposed schemas, so migration 0014 publishes
`public.openiwatch_user_has_password(uuid)` — a boolean, `service_role` only,
and the hash never leaves the database. Without it the check would run and
silently never fire, which is worse than not having it: the script would report
the account as compliant.

### It is idempotent, and it adopts rather than duplicates

Every step asks what is already there and writes only the difference, so a
second run reports no changes. An existing account is looked up first and
adopted — the previous revision called `createUser` and read "already exists"
out of the failure, which also swallowed real errors. Adoption never resets a
password, never replaces an Azure identity, and never creates a second account:
addresses are normalized, so `Casey@Example.com` and `casey@example.com` are one
person.

It also converges the role. `user_roles_unique_scope` keys on the role itself,
so upserting a *different* role adds a second row and the user holds both; the
script removes the surplus instead. The new role is granted before the old ones
are revoked, deliberately — the reverse order rolls back badly, because undoing
a removal means calling `createRole`, so if that is what failed the undo fails
too and the user is left holding nothing.

A membership in a *different* organization stops the run rather than quietly
widening someone's access across tenants; `--allow-additional-organization`
says it was intended.

**No invitation is sent.** `createUser` rather than `inviteUserByEmail`, because
an invite mails on Supabase's schedule with Supabase's wording at a moment the
administrator did not choose. Provisioning someone and telling them about it are
separate acts.

**All-or-nothing.** PostgREST cannot wrap those writes in one transaction, so
the script records every row it creates and unwinds them in reverse on any
failure. A partial account is the dangerous outcome: the person would hit
"Access not authorized" — safe in itself — while the dashboard suggested they
had been granted access.

Re-running is safe: an existing auth user is reused, and rows that already
existed before the run are left alone on rollback.

---

## What is verified, and what is not

**Verified by executed tests (48 auth + 23 authorization, all passing):**

- Microsoft sign-in invokes `provider: 'azure'`, requests only the `email`
  scope, and redirects to `https://openiwatch.netlify.app/auth/callback`;
- a hostile `next` is discarded at every entry point;
- magic link uses `signInWithOtp` with `shouldCreateUser: false` and
  `emailRedirectTo` of `/auth/confirm`;
- unknown, unauthorized and rate-limited addresses produce one identical
  response;
- a code is exchanged exactly once across repeated handling;
- expired, already-used, cancelled and cross-browser failures each produce a
  distinct, actionable message;
- every credential is stripped from the URL, query and fragment, on success and
  on failure;
- an authenticated user with no profile, an inactive profile, or no membership
  is refused, and no membership is ever created for them;
- the authorization screen exposes nothing operational;
- sign-out clears session, authorization state and OneSignal identity;
- OneSignal identity association still follows the session;
- no password field, no signup, no password reset;
- no secret key, SMTP credential or Azure secret in the built bundle.

**Not verified — requires live services:**

- that Entra ID accepts the redirect URI and returns a usable code;
- that Supabase's Azure provider is configured with a working client id and
  secret;
- that Resend actually delivers the mail, and how fast;
- that a real magic link verifies against a real Supabase project;
- that the deployed `/auth/callback` and `/auth/confirm` resolve on
  `openiwatch.netlify.app` — the SPA fallback is asserted locally, not against
  the deployment;
- session restoration against a real Supabase session after a refresh.

**Supabase Auth configuration cannot be read or written from here.** The
Supabase MCP control plane exposes the database, migrations, Edge Functions and
API keys, but not Auth settings — Site URL, redirect URLs, the Azure provider
and SMTP are dashboard-only, and this environment holds no
`SUPABASE_ACCESS_TOKEN` and has no route to the Management API. Those steps are
listed as manual actions and have not been performed.

The same limit applies to **function secrets**, which is why no first user has
been provisioned: `provision-user.mjs` needs `SUPABASE_SECRET_KEY`, and a secret
key can only be read from the dashboard's API Keys page. Provisioning is
therefore a manual action too, and the first authorized email and role have not
been supplied.
