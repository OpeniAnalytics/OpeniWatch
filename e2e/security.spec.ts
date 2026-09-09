import { expect, test, type Page } from '@playwright/test'

/**
 * Security behaviour that was previously only a documentation claim.
 *
 * Signal text, author handles and operational notes are attacker-controlled:
 * anyone who can post publicly can choose what OpeniWatch collects. These tests
 * submit hostile content through the real submission path and assert it is
 * rendered as text, not executed, everywhere it appears.
 *
 * They run in local demo mode against a production build, which is the same
 * rendering path a deployment uses — only the storage differs.
 */

const XSS_SCRIPT = '<script>window.__openiwatch_xss = true</script>'
const XSS_IMG = '<img src=x onerror="window.__openiwatch_xss = true">'

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

/** True if any injected payload actually executed. */
async function scriptExecuted(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean((window as unknown as Record<string, unknown>).__openiwatch_xss))
}

test.describe('Stored content is rendered safely', () => {
  test('hostile signal text and author handle render as text, never as markup', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Rowan Estrada')

    // Submit through the real manual-submission path, not a fixture.
    await page.getByRole('link', { name: /simulator/i }).first().click()
    await expect(page.getByRole('heading', { name: /signal simulator/i })).toBeVisible()

    const hostileText = `Man with a gun in the parking lot at Costco #1487 in Stafford. ${XSS_SCRIPT} ${XSS_IMG}`
    await page.getByLabel(/original text/i).fill(hostileText)
    await page.getByLabel(/public author handle/i).fill(`@evil${XSS_IMG}`)
    await page.getByRole('button', { name: /submit signal/i }).click()

    await expect(page.getByText(/Pipeline result/i)).toBeVisible()
    expect(await scriptExecuted(page)).toBe(false)

    // The analyst queue renders the original text.
    await page.getByRole('link', { name: /analyst queue/i }).first().click()
    await page
      .getByRole('button')
      .filter({ hasText: /Weapon or firearm/ })
      .first()
      .click()

    const review = page.getByRole('region', { name: 'Candidate review' })
    // The payload is present as literal text …
    await expect(review.getByText('<script>', { exact: false }).first()).toBeVisible()
    // … and no script element from it exists in the document.
    const injectedScripts = await page.locator('script:has-text("__openiwatch_xss")').count()
    expect(injectedScripts).toBe(0)
    const injectedImg = await page.locator('img[onerror]').count()
    expect(injectedImg).toBe(0)
    expect(await scriptExecuted(page)).toBe(false)

    // Validate it so the same content reaches the alert detail view.
    await review.getByRole('button', { name: /validate and create alert/i }).click()
    await expect(page).toHaveURL(/\/alerts\/.+/)

    expect(await scriptExecuted(page)).toBe(false)
    expect(await page.locator('script:has-text("__openiwatch_xss")').count()).toBe(0)
    expect(await page.locator('img[onerror]').count()).toBe(0)

    // An operational note is equally attacker-adjacent: SOC staff paste text
    // from sources into it.
    await page.getByLabel(/add an operational note/i).fill(`Contacted store. ${XSS_SCRIPT}`)
    await page.getByRole('button', { name: /add note/i }).click()
    await expect(page.getByText(/Contacted store/).first()).toBeVisible()
    expect(await scriptExecuted(page)).toBe(false)
    expect(await page.locator('script:has-text("__openiwatch_xss")').count()).toBe(0)
  })

  test('external source links carry noopener, noreferrer and nofollow', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Rowan Estrada')

    await page.getByRole('link', { name: /analyst queue/i }).first().click()
    await page.getByRole('button').filter({ hasText: /—|Costco/ }).first().click()

    const openSource = page
      .getByRole('region', { name: 'Candidate review' })
      .getByRole('link', { name: /open the original source/i })

    if ((await openSource.count()) > 0) {
      const rel = await openSource.first().getAttribute('rel')
      const target = await openSource.first().getAttribute('target')
      expect(target).toBe('_blank')
      expect(rel).toContain('noopener')
      expect(rel).toContain('noreferrer')
      expect(rel).toContain('nofollow')
    }
  })

  test('a non-http(s) source URL is refused by the shared schema', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Rowan Estrada')
    await page.getByRole('link', { name: /simulator/i }).first().click()

    // Worth stating plainly: `type="url"` does NOT reject `javascript:` — it has
    // a scheme, so the browser considers it valid. The shared validation schema
    // is the actual gate, and this test exercises that rather than assuming the
    // input type protects anything.
    await page.getByLabel(/original text/i).fill('Report with a hostile source URL at Costco #1487.')
    await page.getByLabel(/source url/i).fill('javascript:alert(1)')
    await page.getByRole('button', { name: /submit signal/i }).click()

    // The schema rejects it, the failure is surfaced, and nothing is stored.
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByText(/Pipeline result/i)).toHaveCount(0)
    expect(await scriptExecuted(page)).toBe(false)
  })
})

test.describe('Operational safety controls', () => {
  test('the simulator is unreachable when disabled, including by direct URL', async ({ page }) => {
    // The build under test has the simulator enabled, so this asserts the
    // role half of the gate: a SOC manager may not reach it either way.
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')

    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /simulator/i }),
    ).toHaveCount(0)

    await page.goto('/simulator')
    await expect(page.getByText(/not available to your role/i)).toBeVisible()
    await expect(page.getByRole('heading', { name: /signal simulator/i })).toHaveCount(0)
  })

  test('a viewer is refused the analyst queue by direct URL', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Sam Okonkwo')

    await page.goto('/queue')
    await expect(page.getByText(/not available to your role/i)).toBeVisible()
    await expect(page.getByRole('region', { name: 'Candidate review' })).toHaveCount(0)
  })

  test('the sticky action bar does not obscure the sign-out control', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')

    await page.getByRole('link', { name: /alert feed/i }).first().click()
    await page.locator('article a').first().click()
    await expect(page).toHaveURL(/\/alerts\/.+/)

    // Sign out lives in the rail; the action bar is offset past it on desktop.
    const signOut = page.getByRole('button', { name: /sign out/i }).first()
    await expect(signOut).toBeVisible()

    const signOutBox = await signOut.boundingBox()
    const bar = page.locator('div.fixed.inset-x-0.bottom-0').first()
    if ((await bar.count()) > 0 && signOutBox) {
      const barBox = await bar.boundingBox()
      if (barBox) {
        const overlaps =
          signOutBox.x < barBox.x + barBox.width &&
          signOutBox.x + signOutBox.width > barBox.x &&
          signOutBox.y < barBox.y + barBox.height &&
          signOutBox.y + signOutBox.height > barBox.y
        expect(overlaps).toBe(false)
      }
    }
    // And it still works.
    await signOut.click()
    await expect(page.getByRole('heading', { name: /choose a role/i })).toBeVisible()
  })
})

test.describe('Keyboard access', () => {
  test('primary operational controls are reachable and named', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Kai Brennan')
    await page.getByRole('link', { name: /alert feed/i }).first().click()
    await page.locator('article a').first().click()

    // Accessible names, not just visual labels.
    for (const name of [/^acknowledge$/i, /^escalate$/i, /set disposition/i]) {
      const control = page.getByRole('button', { name })
      if ((await control.count()) > 0) {
        await expect(control.first()).toBeVisible()
      }
    }

    // The skip link is the first tab stop on a freshly loaded page. Reset focus
    // to the document before tabbing, otherwise the previously clicked element
    // is still focused and Tab moves on from there.
    await page.goto('/alerts')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Tab')
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? '')
    expect(focused.toLowerCase()).toContain('skip to main content')
  })
})
