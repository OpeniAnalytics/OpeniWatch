import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

/**
 * Some CI images ship a pre-installed Chromium whose build number does not
 * match the one this Playwright version downloads. Point at it directly when
 * it exists so the suite runs without a browser download; fall back to the
 * managed browser everywhere else.
 */
const PREINSTALLED_CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium'
const launchOptions = existsSync(PREINSTALLED_CHROMIUM)
  ? { executablePath: PREINSTALLED_CHROMIUM }
  : {}

/**
 * Critical-workflow end-to-end tests.
 *
 * These run against a production build served by `vite preview`, in local demo
 * mode: no Supabase, OneSignal, Twilio or Zignal credentials are set, which is
 * exactly the configuration a reviewer gets from a fresh clone.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Serial: the tests share one browser-local database per worker.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], launchOptions },
      // The mobile spec asserts phone-viewport behaviour; it belongs to the
      // mobile project only.
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'mobile-acknowledgment',
      use: { ...devices['Pixel 5'], launchOptions },
      testMatch: /mobile\.spec\.ts/,
    },
  ],

  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
