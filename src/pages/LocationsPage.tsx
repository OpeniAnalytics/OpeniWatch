import * as React from 'react'
import { Link } from 'react-router-dom'
import { ACTIVE_ALERT_STATUSES } from '@/domain/enums'
import { Badge, Button, Card, Field, Input, Label } from '@/components/ui/primitives'
import { PageHeader } from '@/components/layout/AppShell'
import { useData, useProviderQuery } from '@/app/DataContext'
import { canAdminister } from '@/data/workflow'

/**
 * Locations.
 *
 * One row per physical location with its assignments nested underneath.
 * Assignments are shown as children rather than as separate rows because the
 * pilot has eight assignments across seven locations, and flattening them
 * would make it look like eight warehouses.
 */
export function LocationsPage() {
  const { reference, provider, session } = useData()
  const [search, setSearch] = React.useState('')
  const { data: alerts } = useProviderQuery((p) => p.listAlerts(), [])

  const mayAdminister = session ? canAdminister(session.role) : false
  const locations = reference?.locations ?? []

  const filtered = locations.filter((location) => {
    if (!search.trim()) return true
    const term = search.toLowerCase()
    const aliases = (reference?.aliases ?? [])
      .filter((a) => a.locationId === location.id)
      .map((a) => a.alias)
      .join(' ')
    return [
      location.officialName,
      location.facilityNumber,
      location.city,
      location.state,
      location.addressLine1,
      aliases,
    ]
      .join(' ')
      .toLowerCase()
      .includes(term)
  })

  return (
    <div>
      <PageHeader
        title="Protected locations"
        description={`${locations.length} physical locations · ${reference?.assignments.length ?? 0} operational assignments`}
      />

      <div className="mb-4 max-w-md space-y-1">
        <Label htmlFor="location-search">Search</Label>
        <Input
          id="location-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Warehouse number, city, address or alias"
        />
      </div>

      <div className="space-y-3">
        {filtered.map((location) => {
          const assignments = (reference?.assignments ?? [])
            .filter((a) => a.locationId === location.id)
            .sort((a, b) => a.assignmentNumber - b.assignmentNumber)
          const aliases = (reference?.aliases ?? []).filter((a) => a.locationId === location.id)
          const contacts = (reference?.contacts ?? []).filter((c) => c.locationId === location.id)
          const locationAlerts = (alerts ?? []).filter((a) => a.alert.locationId === location.id)
          const active = locationAlerts.filter((a) =>
            ACTIVE_ALERT_STATUSES.includes(a.alert.status),
          ).length

          return (
            <Card key={location.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold">{location.officialName}</h2>
                    <Badge variant={location.isActive ? 'success' : 'muted'}>
                      {location.isActive ? 'Monitoring active' : 'Monitoring disabled'}
                    </Badge>
                    {assignments.length > 1 && (
                      <Badge variant="warning">{assignments.length} assignments</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {location.addressLine1}
                    {location.addressLine2 ? `, ${location.addressLine2}` : ''}, {location.city},{' '}
                    {location.state} {location.postalCode}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <p className="tabular text-2xl font-semibold leading-none">{active}</p>
                    <p className="text-xs text-muted-foreground">
                      active of {locationAlerts.length} total
                    </p>
                  </div>
                  {mayAdminister && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void provider.setLocationActive(location.id, !location.isActive)
                      }
                    >
                      {location.isActive ? 'Disable monitoring' : 'Enable monitoring'}
                    </Button>
                  )}
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Warehouse number">{location.facilityNumber}</Field>
                <Field label="County">{location.county ?? '—'}</Field>
                <Field label="Time zone">{location.timeZone}</Field>
                <Field label="Coordinates">
                  {location.latitude != null && location.longitude != null ? (
                    <>
                      <span className="tabular">
                        {location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}
                      </span>
                      <br />
                      <span className="text-xs text-muted-foreground">
                        {location.geocodeSource.replace(/_/g, ' ')}
                      </span>
                    </>
                  ) : (
                    'Not geocoded'
                  )}
                </Field>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <div>
                  <Label>Operational assignments</Label>
                  <ul className="mt-1 space-y-1">
                    {assignments.map((assignment) => (
                      <li key={assignment.id} className="rounded-md border px-2.5 py-1.5 text-sm">
                        <span className="font-medium">{assignment.name}</span>
                        {assignment.coverageNotes && (
                          <p className="text-xs text-muted-foreground">
                            {assignment.coverageNotes}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <Label>Alternate names</Label>
                  {aliases.length === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">None recorded.</p>
                  ) : (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {aliases.map((alias) => (
                        <Badge key={alias.id} variant="outline" title={alias.aliasType}>
                          {alias.alias}
                        </Badge>
                      ))}
                    </div>
                  )}

                  <Label className="mt-3 block">Nearby landmarks</Label>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {location.nearbyLandmarks.map((landmark) => (
                      <Badge key={landmark} variant="muted">
                        {landmark}
                      </Badge>
                    ))}
                  </div>

                  <Label className="mt-3 block">Store features</Label>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {location.storeFeatures.map((feature) => (
                      <Badge key={feature} variant="muted">
                        {feature}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div>
                  <Label>Client contacts</Label>
                  {contacts.length === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">None recorded.</p>
                  ) : (
                    <ul className="mt-1 space-y-1 text-sm">
                      {contacts
                        .sort((a, b) => a.notifyOrder - b.notifyOrder)
                        .map((contact) => (
                          <li key={contact.id} className="rounded-md border px-2.5 py-1.5">
                            <span className="font-medium">{contact.fullName}</span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {contact.role}
                            </span>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              </div>

              {locationAlerts.length > 0 && (
                <Button asChild variant="outline" size="sm" className="mt-4">
                  <Link to={`/alerts?location=${location.id}`}>
                    View {locationAlerts.length} alert{locationAlerts.length === 1 ? '' : 's'}
                  </Link>
                </Button>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}
