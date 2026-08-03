import * as React from 'react'
import { Download, Share, SquarePlus, X } from 'lucide-react'
import { Button } from '@/components/ui/primitives'
import { isIos, isStandalone } from '@/services/pwa/register'

/**
 * Installation guidance.
 *
 * Unobtrusive by design. It appears once, at the bottom of a screen the
 * operator has already finished reading, and a dismissal is permanent — an
 * install prompt that returns every session teaches people to dismiss without
 * reading, which is the same reflex that gets a genuine alert dismissed.
 *
 * It never asks for notification permission. Installing and enabling push are
 * separate decisions, made in separate places, for separate reasons; bundling
 * them is how an operator ends up refusing both.
 *
 * It never renders inside an already-installed application.
 */

const DISMISSED_KEY = 'openiwatch.install-prompt.dismissed'

/**
 * `beforeinstallprompt`, which is Chromium-only and not in the DOM lib.
 * Safari never fires it, which is why the iOS branch below exists.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === 'true'
  } catch {
    // Private browsing can refuse storage. Showing the prompt is the safer
    // failure: it is a hint, not an obligation.
    return false
  }
}

export function InstallPrompt() {
  const [dismissed, setDismissed] = React.useState(true)
  const [deferred, setDeferred] = React.useState<InstallPromptEvent | null>(null)
  const [showIosHelp, setShowIosHelp] = React.useState(false)

  React.useEffect(() => {
    if (isStandalone() || wasDismissed()) return
    setDismissed(false)

    function onBeforeInstallPrompt(event: Event) {
      // Keep the browser's own mini-infobar out of the way; OpeniWatch offers
      // the choice in its own words, at a moment that makes sense.
      event.preventDefault()
      setDeferred(event as InstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  }, [])

  const dismiss = React.useCallback(() => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISSED_KEY, 'true')
    } catch {
      // Nothing to do — the prompt simply reappears next session.
    }
  }, [])

  const install = React.useCallback(async () => {
    if (!deferred) return
    await deferred.prompt()
    await deferred.userChoice
    // Either way this prompt is finished with.
    setDeferred(null)
    dismiss()
  }, [deferred, dismiss])

  if (dismissed) return null
  // Nothing useful to offer: not iOS, and the browser has not said it can
  // install. Staying silent beats explaining an option that does not exist.
  if (!deferred && !isIos()) return null

  return (
    <aside
      className="mt-6 rounded-lg border bg-card p-4 md:hidden"
      aria-labelledby="install-prompt-title"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="install-prompt-title" className="text-[17px] font-semibold">
            Install OpeniWatch
          </h2>
          <p className="mt-1 text-[15px] leading-relaxed text-readable-muted">
            Add OpeniWatch to your home screen for a full-screen app without browser controls, and
            a faster route to the alert feed on shift.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss installation prompt"
          className="touch-target -mr-1 -mt-1 inline-flex min-w-11 items-center justify-center rounded-md text-readable-muted hover:bg-accent hover:text-foreground"
        >
          <X className="size-5" />
        </button>
      </div>

      {deferred ? (
        <Button onClick={install} className="touch-target mt-3 w-full text-[17px]">
          <Download className="size-5" />
          Install
        </Button>
      ) : (
        <>
          <Button
            variant="outline"
            onClick={() => setShowIosHelp((open) => !open)}
            aria-expanded={showIosHelp}
            className="touch-target mt-3 w-full text-[17px]"
          >
            How to add to the home screen
          </Button>
          {showIosHelp && (
            <ol className="mt-3 space-y-2 text-[15px] leading-relaxed text-readable-muted">
              <li className="flex items-start gap-2">
                <Share className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                <span>
                  Tap <strong className="font-semibold text-foreground">Share</strong> in the Safari
                  toolbar.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <SquarePlus className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                <span>
                  Choose{' '}
                  <strong className="font-semibold text-foreground">Add to Home Screen</strong>.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 w-5 shrink-0 text-center font-semibold" aria-hidden="true">
                  3
                </span>
                <span>
                  Confirm with <strong className="font-semibold text-foreground">Add</strong>. Open
                  OpeniWatch from the new icon and sign in as usual.
                </span>
              </li>
            </ol>
          )}
        </>
      )}
    </aside>
  )
}

/**
 * Update notice.
 *
 * A security tool must not swap versions underneath an operator mid-action, and
 * it must not leave them on a stale one indefinitely. So the new version is
 * announced and applied when they say so.
 */
export function UpdateNotice({ onActivate }: { onActivate: () => void }) {
  return (
    <div
      role="status"
      className="pad-safe-bottom fixed inset-x-0 bottom-0 z-[60] border-t bg-primary text-primary-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 p-3">
        <p className="text-[15px] font-medium">A new version of OpeniWatch is ready.</p>
        <Button
          variant="secondary"
          onClick={onActivate}
          className="touch-target text-[15px] font-semibold"
        >
          Reload
        </Button>
      </div>
    </div>
  )
}
