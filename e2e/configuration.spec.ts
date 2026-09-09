import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { expect, test } from '@playwright/test'

/**
 * Configuration behaviour of a REAL production build.
 *
 * The unit tests in src/lib/env.test.ts prove the rules. These prove the rules
 * survive `vite build` — that the values actually reach the bundle, and that a
 * staging build with nothing configured refuses to start rather than showing a
 * dashboard backed by browser-local data.
 *
 * Each case builds the application with a specific environment and serves the
 * output on its own port. Builds are a few seconds each; the alternative is
 * trusting that a compiled constant behaves the way the source did, which is
 * exactly the assumption that put demo mode on a deployed site.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

interface Fixture {
  url: string
  dir: string
  server: Server
}

/** Builds the app with the given env and serves it. Returns its base URL. */
async function buildAndServe(env: Record<string, string>): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'openiwatch-cfg-'))

  execFileSync('npx', ['vite', 'build', '--outDir', dir, '--emptyOutDir', '--logLevel', 'error'], {
    env: {
      ...process.env,
      // Start from a clean slate so the developer's own shell cannot leak in
      // and make a "missing variable" case quietly pass.
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
      VITE_SUPABASE_ANON_KEY: '',
      VITE_ENVIRONMENT_LABEL: '',
      VITE_ENABLE_LOCAL_DEMO: '',
      VITE_ENABLE_SIMULATOR: '',
      ...env,
    },
    stdio: 'pipe',
  })

  const server = createServer((req, res) => {
    const requested = decodeURIComponent((req.url ?? '/').split('?')[0]!)
    let path = join(dir, normalize(requested))
    // SPA fallback, matching the Netlify redirect.
    if (!existsSync(path) || requested === '/') path = join(dir, 'index.html')
    try {
      const body = readFileSync(path)
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { url: `http://127.0.0.1:${port}`, dir, server }
}

async function dispose(fixture: Fixture) {
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
  rmSync(fixture.dir, { recursive: true, force: true })
}

test.describe('Staging never silently falls back to demo mode', () => {
  let fixture: Fixture

  test.beforeAll(async () => {
    // Exactly the reported failure: a staging deployment whose Supabase
    // variables did not reach the build.
    fixture = await buildAndServe({ VITE_ENVIRONMENT_LABEL: 'Staging' })
  })
  test.afterAll(async () => dispose(fixture))

  test('shows a blocking configuration screen, not a dashboard', async ({ page }) => {
    await page.goto(fixture.url)

    await expect(page.getByRole('heading', { name: /openiwatch is not configured/i })).toBeVisible()

    // The exact string the deployed site was showing must be gone.
    await expect(page.getByText(/Local demo mode/i)).toHaveCount(0)
    await expect(page.getByText(/Demo mode · Browser-local data/i)).toHaveCount(0)
    // No sign-in, no shell, no operational screen.
    await expect(page.getByRole('heading', { name: /choose a role/i })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /operations overview/i })).toHaveCount(0)
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
  })

  test('names the missing variables and nothing else', async ({ page }) => {
    await page.goto(fixture.url)
    await expect(page.getByText('VITE_SUPABASE_URL')).toBeVisible()
    await expect(page.getByText('VITE_SUPABASE_PUBLISHABLE_KEY')).toBeVisible()
    // A reference code an administrator can quote safely.
    await expect(page.getByText(/OW-CFG-STG-UK/)).toBeVisible()
  })

  test('creates no provider, no session and no seeded data', async ({ page }) => {
    await page.goto(fixture.url)
    await expect(page.getByRole('heading', { name: /openiwatch is not configured/i })).toBeVisible()

    /*
     * The local provider seeds pilot records into localStorage under
     * `openiwatch.demo.*` the moment it is constructed, and writes a session
     * key when a role is chosen. Neither may exist: no demo database, no
     * fictional session.
     *
     * `openiwatch.theme` is a different thing and is expected — the theme
     * provider still wraps the configuration screen so it renders in the
     * operator's chosen theme. It holds no operational data.
     */
    const keys = await page.evaluate(() => Object.keys(localStorage))
    expect(keys.filter((k) => k.startsWith('openiwatch.demo'))).toEqual([])
    expect(keys).not.toContain('openiwatch.demo.session')

    // And no pilot content leaked onto the screen.
    await expect(page.getByText(/Costco/)).toHaveCount(0)
  })

  test('registers no service worker while misconfigured', async ({ page }) => {
    await page.goto(fixture.url)
    await page.waitForTimeout(500)
    const registrations = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 0
      return (await navigator.serviceWorker.getRegistrations()).length
    })
    expect(registrations).toBe(0)
  })
})

test.describe('Local demo requires explicit enablement', () => {
  let blocked: Fixture
  let enabled: Fixture

  test.beforeAll(async () => {
    blocked = await buildAndServe({}) // nothing set at all
    enabled = await buildAndServe({ VITE_ENABLE_LOCAL_DEMO: 'true' })
  })
  test.afterAll(async () => {
    await dispose(blocked)
    await dispose(enabled)
  })

  test('an unconfigured build blocks rather than starting the demo', async ({ page }) => {
    await page.goto(blocked.url)
    await expect(page.getByRole('heading', { name: /openiwatch is not configured/i })).toBeVisible()
    expect(await page.getByText(/OW-CFG-DEV-UK/).count()).toBe(1)
  })

  test('the demo runs when it is asked for', async ({ page }) => {
    await page.goto(enabled.url)
    await expect(page.getByRole('heading', { name: /choose a role/i })).toBeVisible()
    await page.getByRole('button', { name: /Kai Brennan/i }).click()
    await expect(page.getByRole('heading', { name: /operations overview/i })).toBeVisible()
    await expect(page.getByText(/Demo mode · Browser-local data/i)).toBeVisible()
  })

  test('the simulator is not granted by demo mode alone', async ({ page }) => {
    await page.goto(enabled.url)
    await page.getByRole('button', { name: /Rowan Estrada/i }).click()
    await expect(page.getByRole('heading', { name: /operations overview/i })).toBeVisible()

    // Demo mode is on; VITE_ENABLE_SIMULATOR is not.
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /simulator/i }),
    ).toHaveCount(0)
    await page.goto(`${enabled.url}/simulator`)
    await expect(page.getByText(/not available to your role/i)).toBeVisible()
    await expect(page.getByRole('heading', { name: /signal simulator/i })).toHaveCount(0)
  })
})

test.describe('Supabase configuration selects the Supabase provider', () => {
  let fixture: Fixture

  test.beforeAll(async () => {
    fixture = await buildAndServe({
      // A syntactically valid project that does not exist. The point is which
      // provider is chosen, which is decided before any request is made.
      VITE_SUPABASE_URL: 'https://staging-fixture.supabase.co',
      // A publishable key, which is what the browser is now configured with.
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixtureKEY000000000000',
      VITE_ENVIRONMENT_LABEL: 'Staging',
    })
  })
  test.afterAll(async () => dispose(fixture))

  test('starts the application with no demo banner', async ({ page }) => {
    await page.goto(fixture.url)

    await expect(page.getByRole('heading', { name: /openiwatch is not configured/i })).toHaveCount(0)
    // The whole point: configured means no demo indicator anywhere.
    await expect(page.getByText(/Demo mode · Browser-local data/i)).toHaveCount(0)
    await expect(page.getByText(/Local demo mode/i)).toHaveCount(0)

    // Supabase mode shows the email sign-in form rather than role buttons.
    // There is no password field: passwords were removed from the sign-in
    // experience entirely. See e2e/auth.spec.ts.
    await expect(page.getByLabel(/email/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /Kai Brennan/i })).toHaveCount(0)
  })

  test('the deployed bundle carries no server-side secret', async ({ page, request }) => {
    await page.goto(fixture.url)
    const scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src') ?? ''),
    )
    expect(scripts.length).toBeGreaterThan(0)

    const forbidden = [
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_ACCESS_TOKEN',
      'SUPABASE_DB_PASSWORD',
      'OPENIWATCH_INGEST_SECRET',
      'NETLIFY_AUTH_TOKEN',
    ]

    for (const src of scripts) {
      const body = await (await request.get(`${fixture.url}${src}`)).text()
      for (const name of forbidden) {
        expect(body, `${src} references ${name}`).not.toContain(name)
      }
    }
  })
})
