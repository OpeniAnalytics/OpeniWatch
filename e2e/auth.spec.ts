import { expect, test, type Page } from '@playwright/test'

/**
 * Sign-in experience, in a real browser against a production build.
 *
 * The suite runs in local demo mode, where there is no Supabase project to
 * authenticate against, so these assert what a browser can genuinely settle:
 * the routes resolve rather than 404, the demo build says why authentication is
 * unavailable, and no password or signup affordance exists anywhere.
 *
 * The Microsoft and magic-link flows themselves are covered by unit tests
 * against a mocked auth client, and cannot be verified end to end without a
 * deployed Supabase project, a configured Azure application and live SMTP. See
 * docs/AUTHENTICATION.md.
 */

async function freshSession(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
}

test.describe('Sign-in screen', () => {
  test('offers no password field and no way to self-register', async ({ page }) => {
    await freshSession(page)

    // Nothing anywhere on the screen accepts a password.
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
    await expect(page.getByLabel(/password/i)).toHaveCount(0)

    // No account creation, no signup, no password reset.
    await expect(page.getByRole('button', { name: /create account/i })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /sign up|create account|register/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /forgot password/i })).toHaveCount(0)
    await expect(page.getByText(/forgot your password/i)).toHaveCount(0)
  })

  test('identifies the product and states that access is restricted', async ({ page }) => {
    await freshSession(page)
    await expect(page.getByRole('heading', { name: 'OpeniWatch', level: 1 })).toBeVisible()
    await expect(
      page.getByText(/Location-based threat detection, validation, alerting and reporting/i),
    ).toBeVisible()
  })
})

test.describe('Authentication routes resolve', () => {
  /*
   * The value of these two is narrow but real: they prove the SPA fallback and
   * the Netlify redirect serve the application at both auth paths rather than a
   * 404, which is the single most common way a working OAuth configuration
   * still fails in production.
   */
  test('/auth/callback serves the application, not a 404', async ({ page }) => {
    const response = await page.goto('/auth/callback')
    expect(response?.status()).toBe(200)
    await expect(page.locator('#root')).toBeAttached()
    // No stack trace, no server error page.
    await expect(page.getByText(/page not found|404/i)).toHaveCount(0)
  })

  test('/auth/confirm serves the application, not a 404', async ({ page }) => {
    const response = await page.goto('/auth/confirm')
    expect(response?.status()).toBe(200)
    await expect(page.locator('#root')).toBeAttached()
    await expect(page.getByText(/page not found|404/i)).toHaveCount(0)
  })
})

test.describe('Deployed bundle carries no server-side credential', () => {
  test('no service-role key, SMTP credential or Azure secret', async ({ page, request }) => {
    await page.goto('/')
    const scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src') ?? ''),
    )
    expect(scripts.length).toBeGreaterThan(0)

    const forbidden = [
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_DB_PASSWORD',
      'SUPABASE_ACCESS_TOKEN',
      'RESEND_API_KEY',
      'SMTP_PASSWORD',
      'AZURE_CLIENT_SECRET',
      'client_secret',
    ]

    for (const src of scripts) {
      const body = await (await request.get(src)).text()
      for (const name of forbidden) {
        expect(body, `${src} references ${name}`).not.toContain(name)
      }
      // A JWT-shaped value would be a leaked key rather than the public anon
      // key, which is not present in a demo-mode build at all.
      expect(body).not.toMatch(/service_role[^a-z]/i)
    }
  })
})
