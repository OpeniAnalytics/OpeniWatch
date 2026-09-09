# Mobile and progressive web application

OpeniWatch is used on a phone more often than at a desk. A SOC manager is
paged, opens the alert on the way to a car, and acknowledges it one-handed.
That is the case the interface is designed around.

This document records what changed, why, and what still cannot be verified from
this repository.

---

## What was wrong

The deployed application was reviewed on an iPhone. Four problems, in the order
they cost the most:

1. **The hamburger menu opened where the operator could not see it.** The panel
   rendered inline, in document flow, directly beneath the header. The header is
   sticky, so after scrolling the button stayed on screen while the menu it
   opened stayed at the top of the *document* — hundreds of pixels above the
   viewport. Tapping it appeared to do nothing at all.
2. **Operational text was too small.** `text-xs` (12px) carried timestamps,
   locations, author handles and acknowledgment state — the facts read fastest
   and under the worst conditions.
3. **Muted grey was too faint on the dark theme**, which is the theme a SOC
   actually runs.
4. **Alert cards buried the decision.** Provenance and scoring detail sat above
   the acknowledgment state, pushing it below the fold.

---

## Navigation drawer

`src/components/layout/MobileNavDrawer.tsx`.

| Requirement | How |
| --- | --- |
| Renders against the viewport | `createPortal` into `document.body` |
| Not affected by page scroll | `position: fixed` |
| Opens from the left | `left-0 top-0 bottom-0` |
| Full height including Safari chrome changes | `h-[100dvh]`, the *dynamic* viewport unit — `100vh` puts the bottom of the drawer, and sign out with it, below the usable area when the address bar is expanded |
| Backdrop | Full-viewport overlay, `aria-hidden`, tap to close |
| Background does not scroll | `body` is pinned with `position: fixed` and its scroll offset restored on close |
| The drawer scrolls | `overflow-y-auto overscroll-contain` on the list region only |
| Safe areas | `pad-safe-top` on the header, `pad-safe-bottom` on the footer |
| Sign out always reachable | Pinned footer, outside the scrolling region |
| Closes on route change, backdrop, Escape, close button | All four, tested |
| Focus trapped | Tab and Shift+Tab cycle within the panel |
| Focus restored | Returns to the hamburger, via an explicit ref |
| Named for assistive technology | `role="dialog"`, `aria-modal`, `aria-label="OpeniWatch"`; the close button is labelled |

Z-order: header 30, backdrop 40, panel 50, update notice 60, skip link 70.

---

## Persistent header

`sticky top-0 z-30` with `pad-safe-top`.

Sticky rather than fixed, deliberately. A sticky element is positioned by its
scroll container, so it does not need a spacer beneath it, cannot overlap
content, and does not jump when Safari collapses or expands its chrome — which
is what a fixed header does, because it is positioned against a visual viewport
whose height changes.

`viewport-fit=cover` in `index.html` is what makes `env(safe-area-inset-*)`
report real values. Without it every inset is zero and the header sits under
the status bar.

---

## Typography

Applied in `src/index.css` and across the components.

| Element | Mobile | Desktop |
| --- | --- | --- |
| Root | 16px | 16px |
| Body | 17px | 16px |
| Page title | 30px | 24px |
| Section title | 19px | 18px |
| Alert statement | 19px | 17px |
| Alert source text | 16px | 16px |
| Metadata, timestamps, locations | 15px | 15px |
| Badges | 13px | 13px |
| Buttons | 16px | 14px |
| Form controls | 16px enforced | 14px |
| Paragraph line height | 1.55 | 1.55 |

Two rules matter more than the table:

**Nothing operational renders below 13px, and no `text-xs` survives.** 58
occurrences were replaced. A Playwright test walks every text node in the alert
feed and fails on anything under 13px, so this cannot regress quietly.

**Form controls are pinned to 16px on touch screens.** Below 16px, iOS Safari
zooms the viewport when a field takes focus and the operator loses their place.
The rule is scoped to `@media (pointer: coarse)` and uses `!important` because
an element selector loses to a utility class — the point is that no Tailwind
size can drop a field under the floor by accident. Zoom itself is never
disabled: there is no `user-scalable=no` and no `maximum-scale`.

**Contrast.** A `--readable-muted` token was added and is used for every
operational fact — timestamps, locations, acknowledgment state, author
information. Dark-theme `--muted-foreground` was also lifted from 68% to 76%
lightness.

---

## Alert cards

Ordered for how the card is read under time pressure: severity and status,
then the threat statement, then location, then category, then the source text,
then times, then acknowledgment state.

Behind a disclosure: author profile detail, extended provenance, location and
author-location assessment, and the external source link. These are evidence
for a decision already taken, so they must not push acknowledgment state below
the fold.

- Metadata is single-column below 400px. A two-column grid at 320px wraps
  "Published" onto two lines and puts values under the wrong labels.
- The threat statement is never truncated.
- Source text stays selectable — operators paste it into reports.
- Source links and primary actions are at least 44px.
- **Unacknowledged is not carried by colour alone**: icon, the word, a weight
  change and a border. An operator with a colour vision deficiency, or reading a
  phone in direct sunlight, must not have to tell red text from green.

---

## Alert detail actions

Mobile: Acknowledge is a full-width row of its own. Everything else — assign,
escalate, add note, resolve, disposition — collapses behind "More actions", so
the bar stays one row tall and never grows into the content.

Desktop keeps every control inline, exactly as before.

The bar carries `pad-safe-bottom`, and the page reserves
`calc(7rem + env(safe-area-inset-bottom))` so the last card clears it. On
desktop the bar is offset by `md:left-60` so it never spans under the
navigation rail.

---

## Service worker: one file, two jobs

**This is the load-bearing decision, so it is stated plainly.**

A service worker scope may have exactly one active registration. OneSignal
requires a worker at the root scope to receive pushes. A PWA needs a worker at
the root scope to be installable and to serve an offline shell. Registering two
files at `/` means the second replaces the first: either push breaks, or
installability does.

So both behaviours live in **`public/OneSignalSDKWorker.js`** — the path
OneSignal already expects, granted root scope by the `Service-Worker-Allowed`
header in `netlify.toml`. It `importScripts` the OneSignal SDK worker and adds
the shell caching below it.

The application registers this file itself on startup
(`src/services/pwa/register.ts`), so the shell works and the app is installable
for an operator who never opts in to push. When they later do, the OneSignal
SDK finds the existing registration at the same path and scope and reuses it
rather than creating a second one.

Registration is skipped entirely when configuration is blocked — a
misconfigured deployment must not install a worker that then serves its shell
from cache and makes the fault look intermittent to whoever is fixing it.

### What is cached, and what is refused

**Cached:** the entry document and hashed build assets. Public, identical for
every operator, no operational content.

**Never cached:** alerts, signals, candidates, raw source text, author
information, Supabase REST or Realtime responses, authentication tokens, session
state. The fetch handler refuses any cross-origin response, any non-GET request,
and anything under `/rest/`, `/auth/`, `/functions/` or `/realtime/`.

An operator who goes offline sees the shell and a failure to load data — not a
stale alert list. Showing a cached "no critical alerts" to someone standing in a
car park is a safety problem, not a feature. Offline viewing of operational
records would need an explicit secure design, and there is not one.

Navigations are network-first so a deploy takes effect immediately; hashed
assets are cache-first because a new deploy produces new filenames.

### Updates

A waiting worker announces itself, and the operator gets a "A new version of
OpeniWatch is ready — Reload" notice. Nothing swaps underneath them mid-action,
and nobody is left on a stale build indefinitely.

---

## Installation

`src/components/layout/InstallPrompt.tsx`.

- Appears once, at the bottom of a screen already read. Never on desktop.
- **Permanently dismissible.** A prompt that returns every session teaches
  people to dismiss without reading, which is the same reflex that gets a
  genuine alert dismissed.
- Never rendered inside an already-installed application.
- Chromium: uses the deferred `beforeinstallprompt` event.
- iOS: Safari never fires that event, so concise Share → Add to Home Screen
  instructions are offered instead, collapsed until asked for.
- **It never requests notification permission.** Installing and enabling push
  are separate decisions in separate places. Bundling them is how an operator
  ends up refusing both.

---

## Testing

`e2e/mobile-ui.spec.ts`, 19 tests, run on Chromium at iPhone metrics.

Widths swept for horizontal overflow: **320, 375, 390, 430**, across the
overview, alert feed, locations, reporting and notifications screens.

Also covered: typography floors measured from computed styles; form-control
sizes; header persistence after scrolling; header not covering content; drawer
opening inside the viewport after scrolling; background scroll lock and scroll
restoration; all four close paths; focus trapping and restoration; alert card
ordering and disclosure; 44px action targets; the action bar not covering
content; manifest contents; every icon resolving; iOS standalone metadata; and
the shared service-worker arrangement.

### What these tests cannot prove

Stated because the gap is real and the tests should not be read as covering it:

- **They run on Chromium, not WebKit.** The pinned browser in this image is
  Chromium; `devices['iPhone 13']` selects WebKit and cannot launch here. Layout
  width, computed font size, sticky positioning and focus order are
  engine-independent, so those measurements transfer. Safari-specific behaviour
  does not.
- **Safari's collapsing address bar is not simulated.** `100dvh` and the sticky
  header are the correct instruments for it, and both are applied, but the
  behaviour itself has not been observed on a device.
- **Safe-area insets are zero in the emulator.** The tests assert the inset
  terms are present, not that they produce the right number on a notched phone.
- **Nothing here has been checked on a real iPhone**, because this environment
  has no route to the deployed site.

The remaining verification is a manual pass on a physical device, listed in
`docs/STAGING_ACCEPTANCE.md`.
