import { Link } from 'react-router-dom'
import { DELIVERY_CHANNEL_LABELS, DELIVERY_STATUS_LABELS } from '@/domain/enums'
import { Badge, Button, Card, EmptyState } from '@/components/ui/primitives'
import { SimulatedBadge } from '@/components/alerts/badges'
import { PageHeader } from '@/components/layout/AppShell'
import { formatDateTime } from '@/lib/datetime'
import { useData, useProviderQuery } from '@/app/DataContext'

/**
 * In-app notification inbox.
 *
 * The delivery record IS the in-app notification, so this screen is a direct
 * read of `notification_deliveries` for the signed-in user. Attempts on other
 * channels appear here too, marked with their real outcome — a simulated SMS
 * shows as simulated rather than as sent.
 */
export function NotificationsPage() {
  const { provider } = useData()
  const { data: deliveries, loading } = useProviderQuery((p) => p.listMyNotifications(), [])

  const list = deliveries ?? []
  const unread = list.filter((d) => d.readAt === null)

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Every delivery attempt addressed to you, with its actual outcome."
        actions={
          unread.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                for (const delivery of unread) void provider.markNotificationRead(delivery.id)
              }}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      />

      {loading && list.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading notifications…</p>
      ) : list.length === 0 ? (
        <EmptyState
          title="No notifications"
          description="You will receive a notification when an alert matching one of your subscriptions is validated."
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/admin">Manage subscriptions</Link>
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {list.map((delivery) => (
            <li key={delivery.id}>
              <Card className={delivery.readAt ? 'p-3' : 'border-primary/40 bg-primary/5 p-3'}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{DELIVERY_CHANNEL_LABELS[delivery.channel]}</Badge>
                  <Badge
                    variant={
                      delivery.status === 'delivered'
                        ? 'success'
                        : delivery.status === 'failed'
                          ? 'danger'
                          : 'muted'
                    }
                  >
                    {DELIVERY_STATUS_LABELS[delivery.status]}
                  </Badge>
                  {delivery.isSimulated && <SimulatedBadge />}
                  {!delivery.readAt && <Badge>Unread</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatDateTime(delivery.attemptedAt)}
                  </span>
                </div>

                {delivery.detail && (
                  <p className="mt-1.5 text-sm text-muted-foreground">{delivery.detail}</p>
                )}

                <div className="mt-2 flex flex-wrap gap-2">
                  <Button asChild size="sm">
                    <Link
                      to={`/alerts/${delivery.alertId}`}
                      onClick={() => void provider.markNotificationRead(delivery.id)}
                    >
                      Open alert
                    </Link>
                  </Button>
                  {!delivery.readAt && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void provider.markNotificationRead(delivery.id)}
                    >
                      Mark read
                    </Button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
