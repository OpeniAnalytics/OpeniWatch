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
 * mode. No Supabase, OneSignal, Twilio or Zignal credentials are set.
 *
 * Demo mode has to be requested explicitly — `VITE_ENABLE_LOCAL_DEMO=true` in
 * the build command below. An unconfigured build now refuses to start rather
 * than falling back to browser-local data, and `e2e/configuration.spec.ts`
 * builds its own fixtures to prove that.
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
      // The mobile specs assert phone-viewport behaviour and belong to the
      // mobile projects; the configuration spec builds and serves its own
      // fixtures rather than using the shared demo-mode build.
      testIgnore: /(mobile|mobile-ui|configuration)\.spec\.ts/,
    },
    {
      name: 'mobile-acknowledgment',
      use: { ...devices['Pixel 5'], launchOptions },
      testMatch: /mobile\.spec\.ts/,
    },
    {
      /*
       * iPhone-class metrics, which is what the project owner reviewed on.
       * Individual tests override the width to sweep 320 / 375 / 390 / 430.
       *
       * Chromium with iPhone dimensions rather than `devices['iPhone 13']`:
       * that descriptor selects WebKit, and this image pins a Chromium binary.
       * The measurements here — layout width, computed font size, sticky
       * positioning, focus order — are engine-independent. Genuine WebKit
       * behaviour (Safari's collapsing chrome, real safe-area insets) cannot be
       * tested in this environment either way; see docs/MOBILE.md.
       */
      name: 'mobile-ui',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions,
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
      testMatch: /mobile-ui\.spec\.ts/,
    },
    {
      name: 'configuration',
      use: { ...devices['Desktop Chrome'], launchOptions },
      testMatch: /configuration\.spec\.ts/,
    },
  ],

  webServer: {
    command:
      'VITE_ENABLE_LOCAL_DEMO=true VITE_ENABLE_SIMULATOR=true npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
