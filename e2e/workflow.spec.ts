import { expect, test, type Page } from '@playwright/test'

/**
 * The demo workflow, end to end in a real browser.
 *
 * A simulated firearm report at Costco #1487 travels from ingestion through
 * the analyst queue, validation, the SOC feed, acknowledgment, escalation with
 * store and regional manager notification, resolution, disposition, closure,
 * reporting and the audit trail.
 */

/** Local demo mode keeps state in localStorage; clear it so each test starts fresh. */
async function freshSession(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
}

async function signInAs(page: Page, name: string) {
  await page.goto('/')
  const button = page.getByRole('button', { name: new RegExp(name, 'i') })
  if (await button.isVisible().catch(() => false)) {
    await button.click()
  }
  await expect(page.getByRole('heading', { name: /operations overview/i })).toBeVisible()
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: /sign out/i }).first().click()
  await expect(page.getByRole('heading', { name: /choose a role/i })).toBeVisible()
}

test.describe('OpeniWatch critical workflow', () => {
  test('runs a simulated signal through the complete alert lifecycle', async ({ page }) => {
    await freshSession(page)

    // ---- Sign in as the analyst ------------------------------------------
    await page.getByRole('button', { name: /Rowan Estrada/i }).click()
    await expect(page.getByRole('heading', { name: /operations overview/i })).toBeVisible()

    // The seeded pilot is present.
    await expect(page.getByText(/8 operational assignments/i)).toBeVisible()

    // ---- 1-5. Ingest the Stafford firearm scenario ------------------------
    await page.getByRole('link', { name: /simulator/i }).first().click()
    await expect(page.getByRole('heading', { name: /signal simulator/i })).toBeVisible()

    const scenarioCard = page
      .locator('div')
      .filter({ hasText: /Critical firearm report — Stafford parking lot/ })
      .last()
    await scenarioCard.getByRole('button', { name: /run scenario/i }).click()

    // The pipeline result names the matched location and the critical severity.
    await expect(page.getByText(/Pipeline result/i)).toBeVisible()
    await expect(page.getByText(/Matched to Costco #1487/i).last()).toBeVisible()
    await expect(page.getByText('CRITICAL').first()).toBeVisible()

    // ---- 6-7. The candidate reaches the analyst queue ---------------------
    await page.getByRole('link', { name: /analyst queue/i }).first().click()
    await expect(page.getByRole('heading', { name: /analyst queue/i })).toBeVisible()

    // Select the Stafford candidate.
    await page
      .getByRole('button')
      .filter({ hasText: /Weapon or firearm/ })
      .first()
      .click()

    // The original source, location evidence and score explanation are shown.
    const review = page.getByRole('region', { name: 'Candidate review' })
    await expect(review.getByText(/waving a gun around/i)).toBeVisible()
    await expect(review.getByRole('heading', { name: /incident location/i })).toBeVisible()
    await expect(review.getByText(/Text names Costco #1487/i)).toBeVisible()

    // Author current location defaults to unknown and says why.
    await expect(review.getByText(/current location is unknown/i).first()).toBeVisible()

    // The automated assessment is labelled as such and explains itself.
    await expect(review.getByRole('heading', { name: /automated assessment/i })).toBeVisible()
    await review.getByText(/why this candidate received this score/i).click()
    await expect(review.getByText(/not an analyst judgement/i)).toBeVisible()

    // ---- 8-9. Validate, creating the operational alert --------------------
    await review
      .getByLabel('Analyst note')
      .fill('Reviewed the public source. Location evidence is consistent with Costco #1487.')
    await review.getByRole('button', { name: /validate and create alert/i }).click()

    // Lands on the alert detail for the new alert.
    await expect(page).toHaveURL(/\/alerts\/.+/)
    await expect(page.getByText(/Costco #1487/).first()).toBeVisible()

    // ---- 10. Notification deliveries were recorded ------------------------
    await expect(
      page.getByRole('heading', { name: /notification delivery history/i }),
    ).toBeVisible()
    await expect(page.getByText(/In-app notification/).first()).toBeVisible()
    // Channels without credentials are recorded as simulated, not as sent.
    await expect(page.getByText(/Simulated/).first()).toBeVisible()

    const alertUrl = page.url()

    // ---- 11. The SOC manager sees it in the feed --------------------------
    await signOut(page)
    await signInAs(page, 'Kai Brennan')

    await page.getByRole('link', { name: /alert feed/i }).first().click()
    await expect(page.getByRole('heading', { name: /alert feed/i })).toBeVisible()
    await expect(page.getByText(/Weapon or firearm — Costco #1487/).first()).toBeVisible()

    // ---- 12. Acknowledge --------------------------------------------------
    await page.goto(alertUrl)
    await page.getByRole('button', { name: /^acknowledge$/i }).click()
    await expect(page.getByText(/Acknowledged/).first()).toBeVisible()
    await expect(page.getByRole('heading', { name: /acknowledgment history/i })).toBeVisible()

    // ---- 13. Escalate, recording client notification ----------------------
    await page.getByRole('button', { name: /^escalate$/i }).click()
    const escalateDialog = page.getByRole('dialog')
    await expect(escalateDialog).toBeVisible()
    await escalateDialog
      .getByLabel('Reason', { exact: true })
      .fill('Firearm reported on the property during trading hours.')
    await escalateDialog.getByLabel(/who was notified/i).fill('Regional manager, Store security')
    await escalateDialog.getByLabel(/store manager notified/i).check()
    await escalateDialog.getByLabel(/regional manager notified/i).check()
    await escalateDialog.getByRole('button', { name: /record escalation/i }).click()
    await expect(escalateDialog).toBeHidden()

    await expect(page.getByText(/Store manager notified/).first()).toBeVisible()
    await expect(page.getByText(/Regional manager notified/).first()).toBeVisible()

    // ---- 14. Assign, note, resolve, dispose, close ------------------------
    await page.getByLabel('Assign to').selectOption({ label: 'Jordan Reyes' })
    await page.getByRole('button', { name: /^assign$/i }).click()
    await expect(page.getByText('Jordan Reyes').first()).toBeVisible()

    await page
      .getByLabel(/add an operational note/i)
      .fill('Store security confirmed police are on scene.')
    await page.getByRole('button', { name: /add note/i }).click()
    await expect(page.getByText(/police are on scene/i).first()).toBeVisible()

    await page.getByLabel('Change status').selectOption('resolved')
    await expect(page.getByText('Resolved').first()).toBeVisible()

    await page.getByRole('button', { name: /set disposition/i }).click()
    const dispositionDialog = page.getByRole('dialog')
    await expect(dispositionDialog).toBeVisible()
    await dispositionDialog.getByLabel('Disposition', { exact: true }).selectOption('confirmed')
    await dispositionDialog
      .getByLabel('Rationale', { exact: true })
      .fill('Police attended and detained the subject.')
    await dispositionDialog.getByRole('button', { name: /record disposition/i }).click()
    await expect(dispositionDialog).toBeHidden()
    await expect(page.getByText('Confirmed').first()).toBeVisible()

    await page.getByLabel('Change status').selectOption('closed')

    // ---- 16. The audit trail records every material action ----------------
    await expect(page.getByRole('heading', { name: /full audit trail/i })).toBeVisible()
    for (const action of [
      'candidate alert validated',
      'alert created',
      'alert acknowledged',
      'alert escalated',
      'alert assigned',
      'alert note added',
      'alert disposition set',
    ]) {
      await expect(page.getByText(action, { exact: false }).first()).toBeVisible()
    }

    // ---- 15. Reporting reflects the completed alert -----------------------
    await page.getByRole('link', { name: /reporting/i }).first().click()
    await expect(page.getByRole('heading', { name: /^reporting$/i })).toBeVisible()
    await expect(page.getByText(/alerts validated/i).first()).toBeVisible()
    await expect(page.getByText('Weapon or firearm').first()).toBeVisible()
  })
})

test.describe('Pilot configuration', () => {
  test('shows eight assignments across seven physical locations', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Dana Whitfield')

    await page.getByRole('link', { name: /locations/i }).first().click()
    await expect(page.getByRole('heading', { name: /protected locations/i })).toBeVisible()

    // Seven physical locations.
    for (const name of [
      'Costco #1487',
      'Costco #696',
      'Costco #01147',
      'Costco #353',
      'Costco #1115',
      'Costco #1381',
      'Costco #1211',
    ]) {
      await expect(page.getByRole('heading', { name })).toBeVisible()
    }

    // Plano carries two assignments against one physical location.
    await expect(page.getByText('2 assignments')).toBeVisible()
    await expect(page.getByText('Costco 696 Plano, TX Assignment 1')).toBeVisible()
    await expect(page.getByText('Costco 696 Plano, TX Assignment 2')).toBeVisible()

    // The administration view lists all eight, mapped to their locations.
    await page.getByRole('link', { name: /administration/i }).first().click()
    await page.getByRole('tab', { name: /locations and assignments/i }).click()
    await expect(
      page.getByText(/8 assignments across 7 physical locations/i),
    ).toBeVisible()
  })
})

test.describe('Authorization', () => {
  test('a SOC manager cannot reach the analyst queue and a viewer cannot act', async ({ page }) => {
    await freshSession(page)

    // The SOC manager has no analyst queue in navigation.
    await signInAs(page, 'Kai Brennan')
    const mainNav = page.getByRole('navigation', { name: 'Main' })
    await expect(mainNav.getByRole('link', { name: /analyst queue/i })).toHaveCount(0)
    await expect(mainNav.getByRole('link', { name: /alert feed/i })).toBeVisible()

    // A viewer sees alerts but gets no SOC action bar.
    await signOut(page)
    await signInAs(page, 'Sam Okonkwo')
    await page.getByRole('link', { name: /alert feed/i }).first().click()
    await page.locator('article a').first().click()
    await expect(page).toHaveURL(/\/alerts\/.+/)
    await expect(page.getByRole('button', { name: /^acknowledge$/i })).toHaveCount(0)

    // Administration is read-only and says so.
    await page.getByRole('link', { name: /administration/i }).first().click()
    await expect(page.getByText(/administration settings are read-only/i)).toBeVisible()
  })
})

test.describe('Integration honesty', () => {
  test('labels every connector and provider with its real status', async ({ page }) => {
    await freshSession(page)
    await signInAs(page, 'Dana Whitfield')

    await page.getByRole('link', { name: /administration/i }).first().click()
    await page.getByRole('tab', { name: /integrations/i }).click()

    // Zignal is not pretended to work.
    await expect(page.getByText('Zignal / Spyglass').first()).toBeVisible()
    await expect(page.getByText(/requires vendor documentation/i).first()).toBeVisible()

    // Twilio reports itself unavailable rather than silently failing.
    await expect(page.getByText(/Twilio SMS/).first()).toBeVisible()
    await expect(page.getByText(/interface only in Phase 1/i).first()).toBeVisible()
  })
})
