# Role test matrix

What each role may do, where it is enforced, and how it is verified.

Legend for **Verified**:

- **PG** — proven against real PostgreSQL by `npm run test:rls` (28 scenarios)
- **UT** — proven by Vitest (`src/data/workflow.test.ts`, `provider.test.ts`)
- **E2E** — proven through the interface by Playwright (`e2e/workflow.spec.ts`,
  `e2e/security.spec.ts`)
- **STAGING** — covered by `npm run validate:staging`; **not yet executed**

## Capability matrix

| Capability | super_admin | program_admin | analyst | soc_manager | soc_operator | viewer | Enforced by | Verified |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | --- | --- |
| Sign in | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Supabase Auth | STAGING |
| View alerts, locations, reporting | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | RLS `is_program_member` | PG, UT, E2E |
| Open the analyst queue | ✓ | ✓ | ✓ | — | — | — | RLS + `RequireRole` route | PG, UT, E2E |
| Submit a signal manually | ✓ | ✓ | ✓ | — | — | — | RLS `signals` INSERT | PG |
| Triage a candidate | ✓ | ✓ | ✓ | — | — | — | RLS `candidate_alerts` UPDATE | PG, UT |
| **Validate — create an alert** | ✓ | ✓ | ✓ | — | — | — | RLS `alerts` INSERT + `validated_by = auth.uid()` | PG, UT, E2E |
| Acknowledge | ✓ | ✓ | ✓ | ✓ | ✓ | — | RLS `can_operate` | PG, UT, E2E |
| Assign / escalate / resolve | ✓ | ✓ | ✓ | ✓ | ✓ | — | RLS `can_operate` | PG, UT, E2E |
| Add an operational note | ✓ | ✓ | ✓ | ✓ | ✓ | — | RLS, `author_user_id = auth.uid()` | PG, UT |
| Set a final disposition | ✓ | ✓ | ✓ | ✓ | ✓ | — | RLS `can_operate` | UT, E2E |
| Change administration settings | ✓ | ✓ | — | — | — | — | RLS `can_administer` | PG, UT, E2E |
| Change another user's role | ✓ | ✓ | — | — | — | — | RLS `user_roles` | PG, UT |
| Grant `super_admin` | ✓ | — | — | — | — | — | RLS `WITH CHECK` | PG, UT |
| Kill switch / auto-escalation switch | ✓ | ✓ | — | — | — | — | RLS `system_settings` | UT |
| Reach the simulator | ✓ | ✓ | ✓ | — | — | — | `VITE_ENABLE_SIMULATOR` **and** role | E2E |
| Edit a signal | — | — | — | — | — | — | No UPDATE policy; privilege revoked | PG |
| Alter an audit event | — | — | — | — | — | — | No policy, trigger, privilege revoked | PG |
| Read `ingest_rate_limits` | — | — | — | — | — | — | RLS with no policies; privilege revoked | PG |
| Read another organization's data | — | — | — | — | — | — | RLS `is_org_member` | STAGING |

## Direct URL access

Route-level checks hold when a URL is typed, not only when navigation is
hidden. `RequireRole` in `src/App.tsx` renders a refusal that names the required
role. This is a convenience: RLS is the boundary, and the refusal message says
so.

| Route | Restricted to | Behaviour otherwise | Verified |
| --- | --- | --- | --- |
| `/queue` | analyst, program_admin, super_admin | Refusal panel | E2E — a viewer is sent to `/queue` by `page.goto`, not by clicking, and gets the refusal panel with no candidate review region present |
| `/simulator` | same, **and** `VITE_ENABLE_SIMULATOR=true` | Refusal panel naming which condition failed | E2E — a SOC manager has no simulator link and typing `/simulator` yields the refusal panel with no simulator heading |
| `/admin` | Everyone may view | Every control disabled; read-only notice | E2E |
| `/alerts/:id` | Any program member | SOC action bar absent for viewers | E2E |

These are interface controls and the tests treat them as such. **The route
refusal is not the security boundary** — RLS is, and RLS under a live Supabase
Auth session is still unverified. A test proving a button is hidden proves
nothing about the database; the corresponding database-level proofs are the PG
rows in the capability matrix above, plus the STAGING rows that remain
outstanding.

## Verifying against staging

```bash
npm run validate:staging
```

Signs in as all six accounts through real Supabase Auth and attempts every
denied operation, reporting `refused by the database`, `filtered to zero rows by
policy`, or `PERMITTED` — the last being a failure.
