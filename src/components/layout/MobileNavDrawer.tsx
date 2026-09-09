import * as React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/**
 * Mobile navigation drawer.
 *
 * Replaces an inline panel that rendered in document flow directly beneath the
 * header. That panel was invisible to anyone who had scrolled: the header is
 * sticky, so the button stayed on screen while the menu it opened stayed at the
 * top of the document, hundreds of pixels above the viewport. Tapping the
 * hamburger appeared to do nothing.
 *
 * This renders through a portal into `document.body`, positions against the
 * viewport rather than the document, and so opens in front of the operator
 * wherever they happen to be in the feed.
 *
 * Height uses `100dvh` — the *dynamic* viewport unit — so the drawer tracks
 * Safari's collapsing address bar. With `100vh` the bottom of the drawer, and
 * with it the sign-out control, sits below the usable area whenever the browser
 * chrome is expanded.
 */

/** Focusable descendants, in document order. */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',')
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}

export function MobileNavDrawer({
  open,
  onClose,
  title = 'Navigation',
  children,
  footer,
  restoreFocusTo,
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  footer?: React.ReactNode
  /** Where focus returns on close. Defaults to whatever had it when opened. */
  restoreFocusTo?: React.RefObject<HTMLElement>
}) {
  const panelRef = React.useRef<HTMLDivElement>(null)
  const closeButtonRef = React.useRef<HTMLButtonElement>(null)
  // The element that had focus when the drawer opened — usually the hamburger.
  const restoreFocusRef = React.useRef<HTMLElement | null>(null)

  // Lock background scrolling while open, so a swipe over the backdrop moves
  // nothing behind it. The scroll position is preserved and restored.
  React.useEffect(() => {
    if (!open) return
    const { body } = document
    const scrollY = window.scrollY
    const previous = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
    }
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.width = '100%'
    body.style.overflow = 'hidden'

    return () => {
      body.style.position = previous.position
      body.style.top = previous.top
      body.style.width = previous.width
      body.style.overflow = previous.overflow
      window.scrollTo(0, scrollY)
    }
  }, [open])

  // Move focus into the drawer on open; put it back on close.
  React.useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null
      // Focus the close button rather than the first link: it is the control
      // most likely to be wanted, and it names the drawer for a screen reader.
      window.requestAnimationFrame(() => closeButtonRef.current?.focus())
      return
    }
    const toRestore = restoreFocusTo?.current ?? restoreFocusRef.current
    restoreFocusRef.current = null
    if (toRestore && document.contains(toRestore)) toRestore.focus()
  }, [open, restoreFocusTo])

  // Escape closes; Tab is trapped inside the panel.
  React.useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const panel = panelRef.current
      if (!panel) return
      const focusable = focusableWithin(panel)
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement as HTMLElement | null

      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className="md:hidden" data-testid="mobile-nav-drawer">
      {/* Backdrop. Tapping it closes. */}
      <div
        className="fixed inset-0 z-40 bg-black/60"
        onClick={onClose}
        // The close button and Escape both do this accessibly; the backdrop is
        // a convenience for touch and is hidden from assistive technology.
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed bottom-0 left-0 top-0 z-50 flex h-[100dvh] w-[min(20rem,85vw)] flex-col border-r bg-card shadow-xl"
      >
        <div className="pad-safe-top shrink-0 border-b">
          <div className="flex items-center justify-between gap-2 px-4 py-3">
            <p className="text-lg font-semibold">{title}</p>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Close navigation"
              className="touch-target inline-flex min-w-11 items-center justify-center rounded-md px-3 text-readable-muted hover:bg-accent hover:text-foreground"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        {/* The drawer itself scrolls when the list is longer than the phone. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">{children}</div>

        {footer && <div className="pad-safe-bottom shrink-0 border-t px-3 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
