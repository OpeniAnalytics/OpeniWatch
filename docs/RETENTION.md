# Data retention

**Status: implemented but not verified.** The settings, report, purge, holds and
audit are complete and apply cleanly. No purge has been run against a live
project, and the scheduler is deliberately not enabled.

## Principle

Deleting operational evidence is a deliberate act, never a default. Retention is
therefore **off** for every program until an administrator turns it on, a dry run
is always available without turning it on, and every purge writes both a run
record and an audit event.

Audit events are never purged by the retention function. Destroying the record
of a deletion defeats the point of having one.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `programs.retention_enabled` | `false` | Master switch. A real purge refuses without it |
| `programs.signal_retention_days` | 365 | How long raw signals are kept |
| `programs.alert_retention_days` | inherits signals | How long closed alerts are kept |
| `programs.audit_retention_days` | null (keep forever) | Recommended default for a security record |

## What is eligible

**Signals** older than the window, **except** any signal behind a validated
alert. That signal is operational evidence and is governed by the alert's
retention, not its own.

**Alerts** older than the window **and** in `closed` status. An open or
unresolved incident is never purged regardless of age.

**Never eligible:** audit events, anything under an active hold, and anything in
a program with `retention_enabled = false`.

## Legal and administrative holds

```sql
insert into public.retention_holds (organization_id, entity_type, entity_id, reason, placed_by)
values ('<org>', 'alert', '<alert-id>', 'Litigation hold — matter 2026-014', auth.uid());
```

A held record is excluded from every purge and counted in the run's `held_back`
figure, so a purge can always explain what it skipped. Release with
`released_at`.

## Running it

Dry run — read-only, safe at any time, and does not require the master switch:

```sql
select * from openiwatch.retention_report('<program-id>');
```

```
 entity | eligible | held_back |           cutoff
--------+----------+-----------+----------------------------
 signal |     1240 |         3 | 2025-08-02 09:14:00+00
 alert  |       18 |         1 | 2025-08-02 09:14:00+00
```

Recorded dry run:

```sql
select openiwatch.run_retention('<program-id>', true, auth.uid());
```

Real purge — requires `retention_enabled = true`:

```sql
update public.programs set retention_enabled = true where id = '<program-id>';
select openiwatch.run_retention('<program-id>', false, auth.uid());
```

Every run appends to `retention_runs` and writes a `retention.dry_run` or
`retention.purged` audit event carrying the counts, the cutoffs and the
held-back total.

## Scheduling — disabled by default

No schedule is configured. To enable one once a program has opted in:

```sql
select cron.schedule(
  'openiwatch-retention',
  '0 3 * * *',
  $$select openiwatch.run_retention(id, false, null)
      from public.programs where retention_enabled$$
);
```

Run it as a dry run for at least a full retention cycle first, and read the
`retention_runs` rows, before letting it delete anything.

## Testing safely

Only ever purge clearly marked test data. `scripts/perf-dataset.sql` tags every
record it creates with a `perf-` source record id, and the cross-tenant fixtures
in `validate-staging.mjs` are prefixed `ZZ-ISOLATION-TEST`.
