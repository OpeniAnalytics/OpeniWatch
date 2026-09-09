# Pilot setup

The first deployment is an eight-assignment pilot supporting security
operations for Costco locations.

---

## The pilot data

### Organization and program

| | |
| --- | --- |
| Organization | Configurable — defaults to *Openi Security Services*, slug `openi-security-services` |
| Program | **Costco Pilot**, slug `costco-pilot`, client *Costco Wholesale* |
| Signal retention | 365 days |

The organization name is deliberately not hardcoded, because the
security-services partner may be renamed. The id and slug stay stable so
seeded references survive a rename. See
[`DEPLOYMENT.md`](DEPLOYMENT.md#name-the-organization).

### Seven physical locations

| Warehouse | Address | City | State | ZIP | Time zone | Local reference |
| --- | --- | --- | --- | --- | --- | --- |
| Costco #1487 | 12717 Network Drive | Stafford | TX | 77477 | America/Chicago | — |
| Costco #696 | 1701 Dallas Parkway | Plano | TX | 75093 | America/Chicago | — |
| Costco #01147 | 3900 Dublin St. | New Orleans | LA | 70118 | America/Chicago | — |
| Costco #353 | 3775 Hacks Cross Rd. | Memphis | TN | 38125 | America/Chicago | — |
| Costco #1115 | 7940 Richmond Highway | Alexandria | VA | 22306 | America/New_York | **Mt. Vernon** |
| Costco #1381 | 1500 US-287, Building #100 | Mansfield | TX | 76063 | America/Chicago | — |
| Costco #1211 | 791 N. Krocks Rd. | Allentown | PA | 18106 | America/New_York | — |

Warehouse numbers are stored as text: `01147` is not the integer 1147, and the
public writes it both ways. The matcher accepts both forms, but only when a
store-context word or a `#` precedes the number, so a bare four-digit number in
unrelated text does not match.

Each location carries approximate coordinates seeded without a paid geocoding
service (`geocode_source = 'seeded_approximate'`), three circular geofences
(property 200 m, parking 400 m, vicinity 1600 m), nearby landmarks, store
features and public aliases.

> **Before production use, re-geocode the locations.** The seeded coordinates
> are accurate enough for vicinity matching, not for dispatch.

### Eight operational assignments

| # | Assignment | Physical location |
| --: | --- | --- |
| 1 | Costco 1487 Stafford, TX | Costco #1487 |
| 2 | Costco 696 Plano, TX Assignment 1 | **Costco #696** |
| 3 | Costco 01147 New Orleans, LA | Costco #01147 |
| 4 | Costco 696 Plano, TX Assignment 2 | **Costco #696** |
| 5 | Costco 353 Memphis, TN | Costco #353 |
| 6 | Costco 1115 Mt. Vernon, VA | Costco #1115 |
| 7 | Costco 1381 Mansfield, TX | Costco #1381 |
| 8 | Costco 1211 Allentown, PA | Costco #1211 |

**Assignments 2 and 4 reference the same physical warehouse.** This is why
assignments are a separate table rather than columns on `locations`, and it is
covered by both a unit test and an end-to-end test.

### Threat taxonomy

Twenty-one categories are seeded across five groups. Administrators may add
categories or deactivate them; nothing in the application treats the list as
closed. Full list in `src/domain/taxonomy.ts` and
[`SCORING_MODEL.md`](SCORING_MODEL.md).

### Scoring and escalation defaults

| Setting | Value |
| --- | --: |
| Critical minimum | 80 |
| High minimum | 60 |
| Moderate minimum | 35 |
| Auto-suppress below | 10 |
| Minimum location confidence | 25 |
| Scorer | `deterministic-v1` |

| Severity | Escalate after | Channel path |
| --- | --: | --- |
| Critical | 5 minutes | in-app → web push → SMS |
| High | 15 minutes | in-app → web push |
| Moderate | 1 hour | in-app |
| Informational | 24 hours | in-app |

---

## Seed users

Six accounts, one per role.

| Name | Email | Role | What it demonstrates |
| --- | --- | --- | --- |
| Avery Sloan | `super.admin@openiwatch.example` | Super administrator | Full platform access |
| Dana Whitfield | `program.admin@openiwatch.example` | Program administrator | Users, roles, locations, categories, thresholds, escalation rules |
| Rowan Estrada | `analyst@openiwatch.example` | Analyst | The only role that can validate |
| Kai Brennan | `soc.manager@openiwatch.example` | SOC manager | Acknowledge, assign, escalate, resolve, dispose — but **not** validate |
| Jordan Reyes | `soc.operator@openiwatch.example` | SOC operator | Works assigned alerts |
| Sam Okonkwo | `viewer@openiwatch.example` | Viewer | Read-only; cannot act on anything |

### Local demo mode

No authentication server, no passwords. The sign-in screen offers the six roles
as one-click choices and says why. Each role genuinely has different
permissions — the demo is not a costume.

### Supabase mode

Passwords are supplied through the environment at run time and are **never
stored in source control**:

```bash
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_SECRET_KEY=<sb_secret_...> \
OPENIWATCH_SEED_PASSWORD='a-strong-development-password' \
npm run seed:users
```

Or per role:

```bash
OPENIWATCH_SEED_PASSWORD_ANALYST='...' \
OPENIWATCH_SEED_PASSWORD_SOC_MANAGER='...' \
npm run seed:users
```

The script:

- refuses to run against a non-local URL without `--allow-production`;
- refuses passwords shorter than 12 characters;
- is safe to re-run — an existing account is updated, not duplicated;
- creates the profile, organization membership, program membership and role for
  each user.

Default notification subscriptions are seeded so a validated alert always has
recipients: the SOC manager program-wide on in-app, push and SMS; the SOC
operator on critical, high and moderate; the analyst on critical only; the
program administrator scoped to Stafford. The viewer has no subscription —
read-only users are not paged.

> These are development accounts. **Rotate or remove them before production
> use**, and create real accounts through the Supabase dashboard.

---

## Demo script

Roughly ten minutes, and it works with no credentials at all.

### Setup

```bash
npm install && npm run dev
```

Open <http://localhost:5173>. On the Simulator screen, **Reset demo data**
returns everything to a known state at any point.

### 1 — Operations overview (analyst)

Sign in as **Rowan Estrada (Analyst)**.

Point out: open critical and high counts, unacknowledged alerts, the analyst
backlog, alerts by monitored location, the detection-to-alert median, and the
live feed. Every figure is computed from records — there are no placeholder
metrics.

### 2 — Generate the incident

**Simulator** → run *"1. Critical firearm report — Stafford parking lot"*.

The pipeline result shows the match to Costco #1487 with its confidence, the
critical severity and the priority score.

### 3 — Analyst review

**Analyst queue** → select the candidate.

Walk through:

- the original source text, source link, provenance and content hash;
- the public author information — and that **author current location is
  unknown**, with the panel explaining that a profile city never establishes
  where someone is;
- the incident-location evidence, in plain language;
- the automated assessment: seven sub-scores, and the full explanation
  including every reduction and severity adjustment;
- that the automated and analyst assessments are separate and both visible.

Add an analyst note, then **Validate and create alert**.

### 4 — Notification

The alert detail opens. Show the notification delivery history: in-app
delivered, other channels recorded as **simulated** because no live provider is
configured. Nothing claims to have been sent that was not.

### 5 — SOC response

Sign out, sign in as **Kai Brennan (SOC manager)**.

Note the analyst queue is **absent** from navigation — a SOC manager cannot
validate.

**Alert feed** → open the alert →

- **Acknowledge** — the response time is recorded;
- **Escalate** — level, reason, who was notified, and the store and regional
  manager flags;
- **Assign** to Jordan Reyes;
- add an **operational note**;
- **Resolve**, set a **disposition** of *Confirmed*, then **Close**.

Try closing before setting a disposition to show the guard.

### 6 — Reporting

**Reporting** → daily and weekly. Signals collected, candidates generated,
alerts validated, breakdowns by severity, location and category, the false
positive rate, and the validation, notification and acknowledgment latencies.
Export the CSV.

### 7 — Audit trail

Back on the alert, scroll to **Full audit trail**: every action with the acting
user, their role, the timestamp and a detail snapshot — including the
validation, carried forward from the candidate.

### 8 — Authorization

Sign in as **Sam Okonkwo (Viewer)**. The alert detail has no action bar, and
administration states plainly that it is read-only for this role and why.

### 9 — The other scenarios, if time allows

- Scenario 4 (customer complaint) — stays **informational**, and the explanation
  says why. Complaint volume never competes with security matters.
- Scenario 5 (old repost) — capped at **moderate**, dispositioned *Outdated*.
- Scenario 6 (duplicates) — the exact repost is auto-marked duplicate; the
  rewordings are surfaced as likely duplicates and counted as corroboration,
  which raises the score.
- Scenario 8 (hedged report) — reduced source credibility, with "I heard" and
  "allegedly" named in the explanation.

---

## Reference alert

The structure the alert detail view renders:

```
CRITICAL THREAT ALERT
Costco #1487 — Stafford, Texas

A public social-media user reports an individual displaying a firearm in the
parking area.

  Source                          Public web source
  Public author                   @demo_stafford_shopper
  Published                       1:39 PM CT
  Detected                        1:41 PM CT
  Validated                       1:44 PM CT
  Incident-location confidence    94%
  Public author profile location  Houston, TX (self-declared)
  Author current location         Unknown
  Status                          Analyst validated

  Actions: Open source · Acknowledge · Assign · Escalate · Add operational note
```

Note that the public profile location and the author's current location are
shown as two separate lines. They are different facts and OpeniWatch never
merges them.
