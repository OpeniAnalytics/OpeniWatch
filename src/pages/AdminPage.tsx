import * as React from 'react'
import {
  APP_ROLES,
  DELIVERY_CHANNEL_LABELS,
  DELIVERY_CHANNELS,
  INTEGRATION_STATUS_LABELS,
  ROLE_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  type AppRole,
  type DeliveryChannel,
  type Severity,
} from '@/domain/enums'
import { Badge, Button, Card, Input, Label, Select } from '@/components/ui/primitives'
import { PageHeader } from '@/components/layout/AppShell'
import { useData } from '@/app/DataContext'
import { canAdminister } from '@/data/workflow'
import { ALL_CONNECTORS } from '@/services/connectors/stubs'
import { ALL_PROVIDERS } from '@/services/notifications/providers'

/**
 * Administration.
 *
 * Users and roles, locations, assignments, threat categories, notification
 * subscriptions, integrations, scoring thresholds and escalation rules.
 *
 * Read access is open to everyone so an operator can see how the system is
 * configured; every control that writes is disabled for roles that cannot
 * write, with the reason stated rather than the control silently failing.
 */

const TABS = [
  'Users and roles',
  'Threat categories',
  'Scoring thresholds',
  'Escalation rules',
  'Notification subscriptions',
  'Integrations',
  'Locations and assignments',
] as const
type Tab = (typeof TABS)[number]

function ReadOnlyNotice({ role }: { role: AppRole }) {
  return (
    <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
      You are signed in as {ROLE_LABELS[role]}. Administration settings are read-only for your role —
      only program administrators may change them. This is enforced by the database as well as the
      interface.
    </div>
  )
}

export function AdminPage() {
  const { provider, reference, session } = useData()
  const [tab, setTab] = React.useState<Tab>('Users and roles')
  const [error, setError] = React.useState<string | null>(null)

  const mayAdminister = session ? canAdminister(session.role) : false

  async function run(action: () => Promise<void>) {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!reference) return <p className="text-sm text-readable-muted">Loading configuration…</p>

  return (
    <div>
      <PageHeader
        title="Administration"
        description={`${reference.organization.name} · ${reference.programs[0]?.name ?? ''}`}
      />

      {!mayAdminister && session && <ReadOnlyNotice role={session.role} />}
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-1 border-b" role="tablist">
        {TABS.map((item) => (
          <button
            key={item}
            role="tab"
            aria-selected={tab === item}
            onClick={() => setTab(item)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === item
                ? 'border-primary text-primary'
                : 'border-transparent text-readable-muted hover:text-foreground'
            }`}
          >
            {item}
          </button>
        ))}
      </div>

      {/* ---------------------------------------------------------------- */}
      {tab === 'Users and roles' && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b bg-muted/50 text-left text-[13px] uppercase tracking-wide text-readable-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Email</th>
                  <th className="px-4 py-2 font-medium">Title</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {reference.profiles.map((profile) => (
                  <tr key={profile.userId}>
                    <td className="px-4 py-2 font-medium">{profile.fullName}</td>
                    <td className="px-4 py-2 text-readable-muted">{profile.email}</td>
                    <td className="px-4 py-2 text-readable-muted">{profile.title ?? '—'}</td>
                    <td className="px-4 py-2">
                      <Select
                        aria-label={`Role for ${profile.fullName}`}
                        className="w-52"
                        disabled={!mayAdminister}
                        defaultValue=""
                        onChange={(e) => {
                          const role = e.target.value as AppRole
                          if (role) void run(() => provider.setUserRole(profile.userId, role))
                        }}
                      >
                        <option value="">Change role…</option>
                        {APP_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'Threat categories' && (
        <Card>
          <p className="border-b px-4 py-3 text-sm text-readable-muted">
            Deactivating a category stops new signals being classified into it. Existing alerts keep
            their category.
          </p>
          <ul className="divide-y">
            {reference.categories.map((category) => (
              <li key={category.key} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{category.label}</span>
                    <Badge variant="muted">{category.group}</Badge>
                    <Badge variant="outline">
                      baseline {SEVERITY_LABELS[category.baselineSeverity]}
                    </Badge>
                    <span className="tabular text-[13px] text-readable-muted">
                      weight {category.severityWeight}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[13px] text-readable-muted">{category.description}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!mayAdminister}
                  onClick={() =>
                    void run(() => provider.setCategoryActive(category.key, !category.isActive))
                  }
                >
                  {category.isActive ? 'Deactivate' : 'Activate'}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'Scoring thresholds' && (
        <Card className="p-4">
          <p className="mb-4 text-sm text-readable-muted">
            The scoring service produces a 0–100 priority score. These thresholds map that score to a
            severity band. The active scorer is{' '}
            <code className="text-[13px]">{reference.thresholds.scorerId}</code>, selected by
            configuration so a different implementation can replace it without a code change
            elsewhere.
          </p>
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              void run(() =>
                provider.updateThresholds({
                  criticalMin: Number(form.get('criticalMin')),
                  highMin: Number(form.get('highMin')),
                  moderateMin: Number(form.get('moderateMin')),
                  autoSuppressBelow: Number(form.get('autoSuppressBelow')),
                  minimumLocationConfidence: Number(form.get('minimumLocationConfidence')),
                }),
              )
            }}
          >
            {(
              [
                ['criticalMin', 'Critical minimum', reference.thresholds.criticalMin],
                ['highMin', 'High minimum', reference.thresholds.highMin],
                ['moderateMin', 'Moderate minimum', reference.thresholds.moderateMin],
                ['autoSuppressBelow', 'Auto-suppress below', reference.thresholds.autoSuppressBelow],
                [
                  'minimumLocationConfidence',
                  'Minimum location confidence',
                  reference.thresholds.minimumLocationConfidence,
                ],
              ] as const
            ).map(([name, label, value]) => (
              <div key={name} className="space-y-1">
                <Label htmlFor={name}>{label}</Label>
                <Input
                  id={name}
                  name={name}
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={value}
                  disabled={!mayAdminister}
                />
              </div>
            ))}
            <div className="flex items-end">
              <Button type="submit" disabled={!mayAdminister}>
                Save thresholds
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'Escalation rules' && (
        <Card>
          <p className="border-b px-4 py-3 text-sm text-readable-muted">
            The delivery path is attempted in order. If an alert is still unacknowledged after the
            configured time it is flagged for escalation. OpeniWatch never notifies emergency
            services automatically.
          </p>
          <ul className="divide-y">
            {reference.escalationRules.map((rule) => (
              <li key={rule.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-28 font-medium">{SEVERITY_LABELS[rule.severity]}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {rule.channelPath.map((channel, index) => (
                      <Badge key={channel} variant="outline">
                        {index + 1}. {DELIVERY_CHANNEL_LABELS[channel]}
                      </Badge>
                    ))}
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <Label htmlFor={`rule-${rule.id}`}>Escalate after (seconds)</Label>
                    <Input
                      id={`rule-${rule.id}`}
                      type="number"
                      min={30}
                      className="w-28"
                      defaultValue={rule.unacknowledgedSeconds}
                      disabled={!mayAdminister}
                      onBlur={(e) => {
                        const value = Number(e.target.value)
                        if (value !== rule.unacknowledgedSeconds && value > 0) {
                          void run(() =>
                            provider.updateEscalationRule(rule.id, {
                              unacknowledgedSeconds: value,
                            }),
                          )
                        }
                      }}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'Notification subscriptions' && (
        <SubscriptionsTab />
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'Integrations' && (
        <div className="space-y-4">
          <Card>
            <h2 className="border-b px-4 py-3 font-semibold">Collection connectors</h2>
            <ul className="divide-y">
              {ALL_CONNECTORS.map((connector) => {
                const record = reference.integrations.find((i) => i.kind === connector.kind)
                const status = record?.status ?? connector.status
                return (
                  <li key={connector.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{connector.displayName}</span>
                      <Badge
                        variant={
                          status === 'implemented'
                            ? 'success'
                            : status === 'simulated'
                              ? 'warning'
                              : 'muted'
                        }
                      >
                        {INTEGRATION_STATUS_LABELS[status]}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-readable-muted">{connector.description}</p>
                  </li>
                )
              })}
            </ul>
          </Card>

          <Card>
            <h2 className="border-b px-4 py-3 font-semibold">Notification providers</h2>
            <ul className="divide-y">
              {ALL_PROVIDERS.map((provider) => {
                const { available, reason } = provider.availability()
                return (
                  <li key={provider.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{provider.displayName}</span>
                      <Badge variant={available ? 'success' : 'muted'}>
                        {available ? 'Available' : 'Unavailable'}
                      </Badge>
                      {provider.channels.map((channel) => (
                        <Badge key={channel} variant="outline">
                          {DELIVERY_CHANNEL_LABELS[channel]}
                        </Badge>
                      ))}
                    </div>
                    <p className="mt-1 text-sm text-readable-muted">{reason}</p>
                  </li>
                )
              })}
            </ul>
          </Card>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'Locations and assignments' && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="border-b bg-muted/50 text-left text-[13px] uppercase tracking-wide text-readable-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">#</th>
                  <th className="px-4 py-2 font-medium">Assignment</th>
                  <th className="px-4 py-2 font-medium">Physical location</th>
                  <th className="px-4 py-2 font-medium">City</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {[...reference.assignments]
                  .sort((a, b) => a.assignmentNumber - b.assignmentNumber)
                  .map((assignment) => {
                    const location = reference.locations.find((l) => l.id === assignment.locationId)
                    return (
                      <tr key={assignment.id}>
                        <td className="tabular px-4 py-2">{assignment.assignmentNumber}</td>
                        <td className="px-4 py-2 font-medium">{assignment.name}</td>
                        <td className="px-4 py-2">{location?.officialName ?? 'Unknown'}</td>
                        <td className="px-4 py-2 text-readable-muted">
                          {location ? `${location.city}, ${location.state}` : '—'}
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant={assignment.isActive ? 'success' : 'muted'}>
                            {assignment.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
          <p className="border-t px-4 py-3 text-sm text-readable-muted">
            {reference.assignments.length} assignments across {reference.locations.length} physical
            locations. Costco #696 in Plano is covered by two assignments.
          </p>
        </Card>
      )}
    </div>
  )
}

/** Notification subscriptions for the signed-in user. */
function SubscriptionsTab() {
  const { provider, reference, session } = useData()
  const [error, setError] = React.useState<string | null>(null)

  if (!reference || !session) return null

  const mine = reference.subscriptions.filter((s) => s.userId === session.userId)

  async function run(action: () => Promise<void>) {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <Card>
        <h2 className="border-b px-4 py-3 font-semibold">Your subscriptions</h2>
        {mine.length === 0 ? (
          <p className="px-4 py-3 text-sm text-readable-muted">
            You have no notification subscriptions. Add one below to receive alerts.
          </p>
        ) : (
          <ul className="divide-y">
            {mine.map((subscription) => {
              const location = reference.locations.find((l) => l.id === subscription.locationId)
              const assignment = reference.assignments.find(
                (a) => a.id === subscription.operationalAssignmentId,
              )
              return (
                <li key={subscription.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {assignment
                        ? assignment.name
                        : (location?.officialName ?? 'All locations in the program')}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {subscription.severities.length === 0 ? (
                        <Badge variant="muted">All severities</Badge>
                      ) : (
                        subscription.severities.map((severity) => (
                          <Badge key={severity} variant="outline">
                            {SEVERITY_LABELS[severity]}
                          </Badge>
                        ))
                      )}
                      {subscription.categoryKeys.length === 0 ? (
                        <Badge variant="muted">All categories</Badge>
                      ) : (
                        subscription.categoryKeys.map((key) => (
                          <Badge key={key} variant="outline">
                            {reference.categories.find((c) => c.key === key)?.label ?? key}
                          </Badge>
                        ))
                      )}
                      {subscription.channels.map((channel) => (
                        <Badge key={channel} variant="secondary">
                          {DELIVERY_CHANNEL_LABELS[channel]}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void run(() => provider.deleteSubscription(subscription.id))}
                  >
                    Remove
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 font-semibold">Add a subscription</h2>
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            const severity = form.get('severity') as Severity | ''
            const categoryKey = form.get('category') as string
            const locationId = form.get('location') as string
            const assignmentId = form.get('assignment') as string
            const channels = DELIVERY_CHANNELS.filter((channel) =>
              form.getAll('channels').includes(channel),
            ) as DeliveryChannel[]

            void run(() =>
              provider.upsertSubscription({
                userId: session.userId,
                locationId: locationId || null,
                operationalAssignmentId: assignmentId || null,
                severities: severity ? [severity] : [],
                categoryKeys: categoryKey ? [categoryKey] : [],
                channels: channels.length > 0 ? channels : ['in_app'],
                isActive: true,
              }),
            )
            event.currentTarget.reset()
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="sub-location">Location</Label>
            <Select id="sub-location" name="location">
              <option value="">All locations</option>
              {reference.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.officialName}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="sub-assignment">Operational assignment</Label>
            <Select id="sub-assignment" name="assignment">
              <option value="">All assignments</option>
              {reference.assignments.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="sub-severity">Severity</Label>
            <Select id="sub-severity" name="severity">
              <option value="">All severities</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="sub-category">Threat category</Label>
            <Select id="sub-category" name="category">
              <option value="">All categories</option>
              {reference.categories
                .filter((c) => c.isActive)
                .map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
            </Select>
          </div>

          <fieldset className="sm:col-span-2 lg:col-span-3">
            <legend className="text-[13px] font-medium uppercase tracking-wide text-readable-muted">
              Delivery channels
            </legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {DELIVERY_CHANNELS.map((channel) => (
                <label key={channel} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    name="channels"
                    value={channel}
                    defaultChecked={channel === 'in_app'}
                    className="size-4"
                  />
                  {DELIVERY_CHANNEL_LABELS[channel]}
                </label>
              ))}
            </div>
            <p className="mt-1 text-[13px] text-readable-muted">
              Channels without configured credentials record a simulated delivery instead of sending.
            </p>
          </fieldset>

          <div className="flex items-end">
            <Button type="submit">Add subscription</Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
