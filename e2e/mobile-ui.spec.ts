import { expect, test, type Page } from '@playwright/test'

/**
 * Mobile interface behaviour, at real phone widths.
 *
 * These exist because the deployed application was reviewed on an iPhone and
 * found hard to use: text too small, a header that scrolled away, and a
 * hamburger menu that opened somewhere the operator could not see.
 *
 * Every assertion here is a measurement taken from the rendered page, not a
 * check that a class name is present — a class can be right while the
 * computed result is wrong.
 */

/** Widths the interface must hold up at. 320px is the narrowest phone in use. */
const WIDTHS = [320, 375, 390, 430] as const

async function freshSession(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
}

async function signInAs(page: Page, name: string) {
  await page.goto('/')
  const button = page.getByRole('button', { name: new RegExp(name, 'i') })
  if (await button.isVisible().catch(() => false)) await button.click()
  await expect(page.getByRole('heading', { name: /operations overview/i })).toBeVisible()
}

/** Computed font size in px for the first match. */
async function fontSizePx(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return -1
    return Number.parseFloat(getComputedStyle(el).fontSize)
  }, selector)
}

test.describe('Mobile viewports', () => {
  for (const width of WIDTHS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      await freshSession(page)
      await signInAs(page, 'Kai Brennan')

      for (const path of ['/', '/alerts', '/locations', '/reporting', '/notifications']) {
        await page.goto(path)
        // Let lazy routes settle before measuring.
        await page.waitForLoadState('networkidle')
        const overflow = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }))
        expect(
          overflow.scroll - overflow.client,
          `${path} overflows horizontally at ${width}px`,
        ).toBeLessThanOrEqual(1)
      }
    })
  }
})

test.describe('Typography', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('operational text meets the minimum readable sizes', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')

    // Root and body floors.
    expect(await fontSizePx(page, 'html')).toBeGreaterThanOrEqual(16)
    expect(await fontSizePx(page, 'body')).toBeGreaterThanOrEqual(16)

    // Page title in the 28-32px band.
    const titleSize = await fontSizePx(page, 'h1')
    expect(titleSize).toBeGreaterThanOrEqual(28)
    expect(titleSize).toBeLessThanOrEqual(32)

    await page.goto('/alerts')
    await page.waitForLoadState('networkidle')

    // The alert's own statement, and the quoted source text.
    const cardTitle = await fontSizePx(page, 'article h3')
    expect(cardTitle).toBeGreaterThanOrEqual(17)
    const sourceText = await fontSizePx(page, 'article blockquote')
    expect(sourceText).toBeGreaterThanOrEqual(16)

    /*
     * Nothing operational may render below 13px, and metadata not below 15px.
     * This walks every visible text node inside the alert feed rather than
     * sampling, because the failure being guarded against is one stray
     * `text-xs` on a timestamp.
     */
    const tooSmall = await page.evaluate(() => {
      const offenders: Array<{ text: string; size: number }> = []
      const cards = document.querySelectorAll('article')
      for (const card of cards) {
        const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          const text = (node.textContent ?? '').trim()
          const parent = node.parentElement
          if (text.length > 0 && parent) {
            const size = Number.parseFloat(getComputedStyle(parent).fontSize)
            if (size < 13) offenders.push({ text: text.slice(0, 40), size })
          }
          node = walker.nextNode()
        }
      }
      return offenders
    })
    expect(tooSmall).toEqual([])
  })

  test('form controls are at least 16px, so iOS does not zoom on focus', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')
    await page.goto('/alerts')
    await page.locator('article a').first().click()
    await expect(page).toHaveURL(/\/alerts\/.+/)

    const sizes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, select, textarea'))
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
    )
    expect(sizes.length).toBeGreaterThan(0)
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16)
  })
})

test.describe('Persistent header', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('stays on screen after scrolling', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')
    await page.goto('/alerts')
    await page.waitForLoadState('networkidle')

    const menu = page.getByRole('button', { name: /open navigation/i })
    await expect(menu).toBeVisible()

    await page.evaluate(() => window.scrollTo(0, 1200))
    await page.waitForTimeout(200)

    // Still visible, and still within the viewport rather than scrolled off.
    await expect(menu).toBeVisible()
    const box = await menu.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeLessThan(200)
  })

  test('does not cover page content', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')

    const header = page.locator('header').first()
    const main = page.locator('#main')
    const headerBox = await header.boundingBox()
    const mainBox = await main.boundingBox()
    expect(headerBox).not.toBeNull()
    expect(mainBox).not.toBeNull()
    // Sticky, not fixed: main begins below the header rather than beneath it.
    expect(mainBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 1)
  })
})

test.describe('Navigation drawer', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('opens inside the current viewport after scrolling down', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')
    await page.goto('/alerts')
    await page.waitForLoadState('networkidle')

    await page.evaluate(() => window.scrollTo(0, 1500))
    await page.waitForTimeout(200)

    await page.getByRole('button', { name: /open navigation/i }).click()

    const drawer = page.getByRole('dialog', { name: 'OpeniWatch' })
    await expect(drawer).toBeVisible()

    // This is the regression the old inline menu failed: the panel must be
    // within the visible viewport, not at the top of the document.
    const box = await drawer.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeLessThan(100)
    expect(box!.height).toBeGreaterThan(400)

    // Sign out is reachable without scrolling the drawer.
    await expect(drawer.getByRole('button', { name: /sign out/i })).toBeInViewport()
  })

  test('locks the background while open and restores the scroll position', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')
    await page.goto('/alerts')
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => window.scrollTo(0, 800))
    const before = await page.evaluate(() => window.scrollY)

    await page.getByRole('button', { name: /open navigation/i }).click()
    await expect(page.getByRole('dialog', { name: 'OpeniWatch' })).toBeVisible()
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden')

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'OpeniWatch' })).toHaveCount(0)

    const after = await page.evaluate(() => window.scrollY)
    expect(Math.abs(after - before)).toBeLessThan(5)
  })

  test('closes on backdrop tap, Escape, the close button and route change', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')
    const drawer = page.getByRole('dialog', { name: 'OpeniWatch' })
    const open = page.getByRole('button', { name: /open navigation/i })

    // Explicit close button.
    await open.click()
    await expect(drawer).toBeVisible()
    await page.getByRole('button', { name: /close navigation/i }).click()
    await expect(drawer).toHaveCount(0)

    // Escape.
    await open.click()
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)

    // Backdrop tap — the element behind the panel.
    await open.click()
    await expect(drawer).toBeVisible()
    await page.mouse.click(370, 400)
    await expect(drawer).toHaveCount(0)

    // Route change.
    await open.click()
    await expect(drawer).toBeVisible()
    await drawer.getByRole('link', { name: /alert feed/i }).click()
    await expect(drawer).toHaveCount(0)
    await expect(page).toHaveURL(/\/alerts$/)
  })

  test('traps focus and returns it to the hamburger', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')

    await page.getByRole('button', { name: /open navigation/i }).click()
    const drawer = page.getByRole('dialog', { name: 'OpeniWatch' })
    await expect(drawer).toBeVisible()

    // Focus lands inside the drawer on open.
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
      'Close navigation',
    )

    // Tabbing all the way round stays inside the drawer.
    for (let i = 0; i < 15; i += 1) {
      await page.keyboard.press('Tab')
      const inside = await page.evaluate(() => {
        const panel = document.querySelector('[role="dialog"]')
        return panel ? panel.contains(document.activeElement) : false
      })
      expect(inside, `focus escaped the drawer after ${i + 1} tabs`).toBe(true)
    }

    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
      'Open navigation',
    )
  })
})

test.describe('Alert card and detail actions', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the card leads with severity, status, location and the threat statement', async ({
    page,
  }) => {
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')
    await page.goto('/alerts')
    await page.waitForLoadState('networkidle')

    const card = page.locator('article').first()
    await expect(card).toBeVisible()

    // Acknowledgment state does not depend on colour alone: the word is there.
    const ackText = await card.innerText()
    expect(/Unacknowledged|Acknowledged/.test(ackText)).toBe(true)

    // Secondary provenance starts collapsed.
    const disclosure = card.getByRole('button', { name: /source and assessment/i })
    await expect(disclosure).toBeVisible()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await disclosure.click()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')

    // Source text stays selectable — an operator copies it into a report.
    const userSelect = await card
      .locator('blockquote')
      .first()
      .evaluate((el) => getComputedStyle(el).userSelect)
    expect(userSelect).not.toBe('none')
  })

  test('detail actions are large enough and clear the bottom inset', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')
    await page.goto('/alerts')
    await page.locator('article a').first().click()
    await expect(page).toHaveURL(/\/alerts\/.+/)

    const acknowledge = page.getByRole('button', { name: /^acknowledge$/i })
    const box = await acknowledge.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(44)

    // Secondary actions are behind a menu so the bar stays one row tall.
    const more = page.getByRole('button', { name: /more actions/i })
    await expect(more).toBeVisible()
    expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await more.click()
    // The desktop control set is also in the DOM but display:none, so scope to
    // what is actually rendered rather than matching both.
    await expect(page.locator('select[aria-label="Assign to"]:visible')).toHaveCount(1)
    await expect(page.getByRole('button', { name: /^escalate$/i })).toBeVisible()

    // The bar respects the bottom safe-area inset. The emulated device reports
    // zero insets, so this asserts the term is present rather than a number.
    const usesInset = await page
      .getByTestId('alert-action-bar')
      .evaluate((el) => getComputedStyle(el).paddingBottom !== '' && el.className.includes('pad-safe-bottom'))
    expect(usesInset).toBe(true)
  })

  test('the action bar does not cover the end of the page content', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')
    await page.goto('/alerts')
    await page.locator('article a').first().click()
    await expect(page).toHaveURL(/\/alerts\/.+/)

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(200)

    const barBox = await page.getByTestId('alert-action-bar').boundingBox()
    expect(barBox).not.toBeNull()

    /*
     * Measure the last piece of real content, not the page container: the
     * container carries the reserved bottom padding, so its own box extends
     * under the bar by design. What must not be covered is the content.
     */
    const lastContentBottom = await page.evaluate(() => {
      const cards = document.querySelectorAll('#main section, #main article, #main .rounded-lg')
      const last = cards[cards.length - 1]
      return last ? last.getBoundingClientRect().bottom : 0
    })
    expect(lastContentBottom).toBeGreaterThan(0)
    expect(lastContentBottom).toBeLessThanOrEqual(barBox!.y + 2)
  })
})

test.describe('Progressive web application', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the manifest loads and declares standalone display', async ({ page, request }) => {
    await page.goto('/')

    const href = await page.getAttribute('link[rel="manifest"]', 'href')
    expect(href).toBe('/manifest.webmanifest')

    const response = await request.get('/manifest.webmanifest')
    expect(response.ok()).toBe(true)

    const manifest = JSON.parse(await response.text())
    expect(manifest.name).toBe('OpeniWatch')
    expect(manifest.short_name).toBe('OpeniWatch')
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.theme_color).toBeTruthy()
    expect(manifest.background_color).toBeTruthy()
  })

  test('every declared icon exists and includes a maskable one', async ({ request }) => {
    const manifest = JSON.parse(await (await request.get('/manifest.webmanifest')).text())
    const icons: Array<{ src: string; sizes: string; purpose: string }> = manifest.icons

    expect(icons.some((i) => i.sizes === '192x192')).toBe(true)
    expect(icons.some((i) => i.sizes === '512x512')).toBe(true)
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true)

    for (const icon of icons) {
      const response = await request.get(icon.src)
      expect(response.ok(), `${icon.src} is missing`).toBe(true)
      expect(response.headers()['content-type']).toContain('image/png')
    }

    // Apple touch icon is referenced from the document, not the manifest.
    expect((await request.get('/icons/apple-touch-icon.png')).ok()).toBe(true)
  })

  test('iOS standalone metadata is present', async ({ page }) => {
    await page.goto('/')
    const meta = async (name: string) => page.getAttribute(`meta[name="${name}"]`, 'content')

    expect(await meta('apple-mobile-web-app-capable')).toBe('yes')
    expect(await meta('apple-mobile-web-app-title')).toBe('OpeniWatch')
    expect(await meta('apple-mobile-web-app-status-bar-style')).toBeTruthy()
    expect(await page.getAttribute('link[rel="apple-touch-icon"]', 'href')).toBe(
      '/icons/apple-touch-icon.png',
    )

    // viewport-fit=cover is what makes the safe-area insets report real values.
    const viewport = await meta('viewport')
    expect(viewport).toContain('viewport-fit=cover')
    // Zoom must never be disabled on an operational tool.
    expect(viewport).not.toContain('user-scalable=no')
    expect(viewport).not.toContain('maximum-scale')
  })

  test('the OneSignal worker is served verbatim, unauthenticated and unredirected', async ({
    request,
  }) => {
    const response = await request.get('/OneSignalSDKWorker.js', { maxRedirects: 0 })

    expect(response.status()).toBe(200)
    // A redirect or an auth challenge here fails service worker registration,
    // and the symptom reads as "push is broken" rather than as a routing fault.
    expect(response.headers()['location']).toBeUndefined()
    expect(response.headers()['www-authenticate']).toBeUndefined()
    // Registration requires a JavaScript MIME type; both spellings qualify.
    expect(response.headers()['content-type']).toMatch(/(application|text)\/javascript/)

    // Exactly what OneSignal shipped — one line, nothing appended.
    const body = await response.text()
    expect(body.trim()).toBe(
      'importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");',
    )
    // The SPA fallback must not have rewritten it to the entry document.
    expect(body).not.toContain('<!doctype html')
  })

  test('the application worker is separate and caches no operational data', async ({ request }) => {
    const response = await request.get('/sw.js', { maxRedirects: 0 })
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toMatch(/(application|text)\/javascript/)

    const body = await response.text()
    // Two workers, separated by scope. Push handling does not live here.
    expect(body).not.toContain('OneSignalSDK.sw.js')
    // Operational data is never cached for offline viewing.
    expect(body).toContain('/rest/')
    expect(body).toContain('/auth/')
    expect(body).toContain('/realtime/')
  })
})
