# Pull request: OpeniWatch Phase 1 and staging preparation

**Branch:** `claude/openiwatch-setup-tse0ua`
**Base:** none — see "Repository note" below.
**Status:** ready for review (6 commits). Do not merge until the staging validation in
[`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) has been run.

## Repository note

`OpeniOracle/OpeniWatch` has **no default branch other than this one**:
`origin/HEAD` points at `claude/openiwatch-setup-tse0ua`, and it is the only
remote branch. There is therefore no base to diff against and no branch to open
a pull request into. Either:

- make `main` the default branch from an initial commit and re-target this
  branch at it, or
- treat this branch as the initial import and review the tree directly.

The diff against the empty tree is the whole repository.

## What this delivers

A functional Phase 1 MVP of OpeniWatch — location-based threat detection,
validation, alerting and reporting — plus the groundwork for a staging
deployment.

The complete operational workflow runs end to end from a fresh clone with no
credentials of any kind:

```
Detect → Locate → Classify → Validate → Alert → Acknowledge → Escalate → Resolve → Report
```

### Database

Twelve ordered, re-runnable migrations. Applying them twice is a no-op, verified
against real PostgreSQL 16 by `npm run test:rls`.

- Multi-tenant hierarchy: organization → program → location → operational
  assignment → users and subscriptions
- Signals, candidate alerts, validated alerts and SOC records as distinct types
- Row Level Security enabled and forced on all 33 tables, 69 policies
- Explicit table privileges, with UPDATE on `signals` and UPDATE/DELETE on
  `audit_events` revoked outright
- Web push registrations, escalation automation, retention framework,
  coordinate verification metadata

### Application

- Deterministic scoring service behind a replaceable interface, retaining seven
  sub-scores and a human-readable explanation
- Three ingestion routes sharing one validation schema
- Seven screens plus sign-in and a notification inbox
- Two data providers behind one contract: browser-local demo, and Supabase
- Server-side filtering and paging, bounded so no screen can pull a whole table

### Server-side

- `ingest-signal` — shared-secret auth compared in constant time, database-backed
  rate limiting, full validation, idempotency
- `dispatch-notifications` — OneSignal REST server-side, claims each delivery
  before sending, records the real outcome
- `escalate-unacknowledged` — idempotent scheduled sweep

## Review focus

1. **`supabase/migrations/0007_row_level_security.sql`** — the security
   boundary. Particularly the `alerts` INSERT policy, which requires both
   `can_validate` and `validated_by = auth.uid()`.
2. **`supabase/migrations/0009_privileges.sql`** — added after discovering the
   migrations relied on Supabase's implicit grants. A policy has no effect
   without the underlying privilege.
3. **`src/services/ingestion/authorLocation.ts`** — the privacy rule. Author
   current location defaults to `unknown` and profile data never establishes it.
4. **`src/data/workflow.ts`** — the lifecycle rules, mirrored by database
   triggers.
5. **`supabase/functions/_shared/notify.ts`** — provider acceptance is recorded
   as `sent`, never `delivered`.

## Verification performed

| Gate | Result |
| --- | --- |
| TypeScript (strict) | Clean |
| ESLint | Clean |
| Unit and integration tests | 166 passed |
| Playwright | 5 passed, including mobile |
| Production build | Entry chunk 236 kB (65 kB gzipped) |
| Migrations applied twice | Clean |
| RLS scenarios (real PostgreSQL) | 28/28 |
| Schema parity (browser vs Edge Function) | Passing |
| Secret scan, full history | 122 blobs, no real secrets |
| Query performance at target volume | All index-backed, under 0.12 ms |

## Not verified

Live Supabase, Netlify and OneSignal are unreachable from the environment this
was built in, and no credentials were available. Authentication, Realtime, the
deployed Edge Functions, web push and the Netlify deployment are therefore
**implemented but not verified**.

`npm run validate:staging` performs every one of those checks and exits
non-zero on failure. Run it before merging.

## Security notes

- No secrets in the repository or its history
- The service-role key is never imported into `src/`
- `.env.example` contains no real values
- One residual dependency advisory (react-router RSC-mode CSRF) with no released
  fix; the reasoning for staying on 7.18.2 is recorded in
  [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md)
