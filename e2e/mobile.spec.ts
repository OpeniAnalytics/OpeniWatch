import { expect, test } from '@playwright/test'

/**
 * Mobile alert acknowledgment.
 *
 * A SOC manager paged away from a desk must be able to open an alert and
 * acknowledge it on a phone. This runs on a Pixel 5 viewport and checks that
 * the primary action is reachable and comfortably large.
 */

test('a SOC manager can acknowledge an alert on a phone', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: /Kai Brennan/i }).click()
  await expect(page.getByRole('heading', { name: /operations overview/i })).toBeVisible()

  // The rail collapses on mobile; navigation is behind the menu button, which
  // now opens a viewport-fixed drawer rather than an inline panel.
  await page.getByRole('button', { name: /open navigation/i }).click()
  const drawer = page.getByRole('dialog', { name: 'OpeniWatch' })
  await expect(drawer).toBeVisible()
  await drawer.getByRole('link', { name: /alert feed/i }).click()
  await expect(page.getByRole('heading', { name: /alert feed/i })).toBeVisible()

  // Alerts are visible immediately on a phone; the filters are collapsed behind
  // a toggle so seven dropdowns do not occupy the whole first screen.
  await expect(page.locator('article').first()).toBeVisible()

  // Filter to the alerts that still need attention.
  await page.getByRole('button', { name: /^filters/i }).click()
  await page.getByLabel('Acknowledgment').selectOption('unacknowledged')
  await expect(page.locator('article').first()).toBeVisible()

  await page.locator('article a').first().click()
  await expect(page).toHaveURL(/\/alerts\/.+/)

  const acknowledge = page.getByRole('button', { name: /^acknowledge$/i })
  await expect(acknowledge).toBeVisible()

  // Large enough to hit reliably under pressure. 44px is the common minimum
  // touch-target guidance; the acknowledge button is sized lg (48px).
  const box = await acknowledge.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)

  await acknowledge.click()

  // Scope to the acknowledgment card: the signed-in user's name also appears in
  // the navigation rail, which is present but hidden at this viewport.
  const ackHistory = page
    .getByRole('heading', { name: /acknowledgment history/i })
    .locator('xpath=ancestor::*[contains(@class,"rounded-lg")][1]')
  await expect(ackHistory).toBeVisible()
  await expect(ackHistory.getByText('Kai Brennan')).toBeVisible()

  // The page must not scroll sideways on a phone.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
})
