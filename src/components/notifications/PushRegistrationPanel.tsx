import * as React from 'react'
import { BellOff, BellRing, Loader2 } from 'lucide-react'
import { Badge, Button, Card } from '@/components/ui/primitives'
import { useData, useProviderQuery } from '@/app/DataContext'
import { checkPushSupport, currentPermission, pushClient } from '@/services/notifications/pushRegistration'
import { formatDateTime } from '@/lib/datetime'

/**
 * Web push opt-in.
 *
 * Every OneSignal subscription call in the interface starts here, and every one
 * of them starts from a click. Nothing on this screen runs on mount except
 * reading the current state: no permission request, no SDK download, no
 * provider contact. An operator who never presses the button never reaches
 * OneSignal at all.
 *
 * Opt-out is deliberately symmetrical — it tells OneSignal to stop AND removes
 * the OpeniWatch record. Doing only the first would leave a row claiming a
 * registration that no longer receives anything; doing only the second would
 * leave a phone buzzing for someone who believes they switched it off.
 */
export function PushRegistrationPanel() {
  const { provider, session, refresh } = useData()
  const { data: subscriptions, reload } = useProviderQuery((p) => p.listPushSubscriptions(), [])

  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const support = checkPushSupport()
  const permission = currentPermission()
  const registrations = (subscriptions ?? []).filter((s) => s.isEnabled && !s.revokedAt)

  /*
   * Keep the stored row honest when the provider rotates a subscription id.
   *
   * A browser can reissue its push endpoint at any time. Without this the row
   * would keep naming an id that no longer receives anything, and a delivery
   * would be accepted by OneSignal and land nowhere.
   */
  React.useEffect(() => {
    if (!session) return
    void pushClient
      .onSubscriptionChange((subscriptionId, optedIn) => {
        if (!subscriptionId || !optedIn) return
        void provider
          .registerPushSubscription({
            providerSubscriptionId: subscriptionId,
            deviceLabel: navigator.userAgent.includes('Mobile') ? 'Mobile browser' : 'Browser',
          })
          .then(reload)
          .catch(() => {
            // The panel reports live state on its next read; a failed refresh
            // must not throw inside a provider callback.
          })
      })
      .catch(() => {})
  }, [provider, session, reload])

  async function run(action: () => Promise<string>) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setNotice(await action())
      reload()
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const enable = () =>
    run(async () => {
      if (!session) throw new Error('Sign in before enabling web push.')
      // The only call site of requestPermission() in the application, and it is
      // inside a click handler.
      const result = await pushClient.optIn(session.userId)
      await provider.registerPushSubscription(result)
      return `Web push enabled on ${result.deviceLabel}.`
    })

  const disable = (subscriptionId: string) =>
    run(async () => {
      // Provider first: if this fails, the row still describes a live
      // registration, which is the truthful state to be left in.
      await pushClient.optOut()
      await provider.removePushSubscription(subscriptionId)
      return 'Web push disabled on this device. OneSignal has been told to stop sending to it.'
    })

  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[19px] font-semibold tracking-tight sm:text-lg">Web push</h2>
          <p className="mt-1 text-[15px] leading-relaxed text-readable-muted">
            Critical and high-severity alerts can reach this device while OpeniWatch is closed. The
            notification shows severity and location only — never the report text or the author.
          </p>
        </div>
        {registrations.length > 0 && <Badge variant="outline">Enabled</Badge>}
      </div>

      {!support.supported ? (
        <p className="mt-3 rounded-md border border-dashed p-3 text-[15px] leading-relaxed text-readable-muted">
          {support.reason}
        </p>
      ) : permission === 'denied' ? (
        <p className="mt-3 rounded-md border border-dashed p-3 text-[15px] leading-relaxed text-readable-muted">
          Notifications are blocked for this site in your browser settings. OpeniWatch cannot
          re-request permission — you will need to allow notifications for this site and return
          here.
        </p>
      ) : (
        <>
          {registrations.length === 0 ? (
            <Button
              className="touch-target mt-3 w-full text-[17px] sm:w-auto"
              disabled={busy || !session}
              onClick={enable}
            >
              {busy ? <Loader2 className="size-5 animate-spin" /> : <BellRing className="size-5" />}
              Enable web push on this device
            </Button>
          ) : (
            <ul className="mt-3 space-y-2">
              {registrations.map((registration) => (
                <li
                  key={registration.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <p className="text-[16px] font-medium">
                      {registration.deviceLabel ?? 'Registered device'}
                    </p>
                    <p className="text-[15px] text-readable-muted">
                      Registered {formatDateTime(registration.createdAt)}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    className="touch-target text-[16px]"
                    disabled={busy}
                    onClick={() => disable(registration.id)}
                  >
                    <BellOff className="size-5" />
                    Turn off
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[15px] font-medium text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-[15px] text-readable-muted">
          {notice}
        </p>
      )}

      <p className="mt-3 border-t pt-3 text-[15px] leading-relaxed text-readable-muted">
        OpeniWatch stores the provider&rsquo;s subscription identifier and a coarse device label
        such as &ldquo;Chrome on Windows&rdquo;. No fingerprint, no location, no advertising
        identifier. Provider acceptance is recorded as <strong>sent</strong>; it is not proof the
        notification reached the device.
      </p>
    </Card>
  )
}
