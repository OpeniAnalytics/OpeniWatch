import { beforeEach, describe, expect, it } from 'vitest'
import { signalInputSchema } from '@/services/ingestion/schema'
import { SIMULATION_SCENARIOS, getScenario } from '@/simulator/scenarios'
import { LOCATION_IDS } from '@/data/seed/pilot'
import { LocalDataProvider } from './provider'

/**
 * End-to-end coverage of the operational workflow against the local provider.
 *
 * This is the demo scenario expressed as a test: a simulated firearm report at
 * Costco #1487 travels from ingestion through validation, notification,
 * acknowledgment, escalation, resolution, disposition and into reporting, with
 * the audit trail checked at each step.
 */

let provider: LocalDataProvider

beforeEach(async () => {
  provider = new LocalDataProvider()
  await provider.resetDemoData()
})

async function runScenario(scenarioId: string) {
  const scenario = getScenario(scenarioId)
  if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`)
  const inputs = scenario.build(new Date()).map((i) => signalInputSchema.parse(i))
  return provider.ingestSignals(inputs)
}

describe('seeded pilot data', () => {
  it('exposes seven physical locations and eight operational assignments', async () => {
    const reference = await provider.getReferenceData()
    expect(reference.locations).toHaveLength(7)
    expect(reference.assignments).toHaveLength(8)
  })

  it('points both Plano assignments at the same physical location', async () => {
    const reference = await provider.getReferenceData()
    const plano = reference.assignments.filter((a) => a.name.includes('Plano'))
    expect(plano).toHaveLength(2)
    expect(new Set(plano.map((a) => a.locationId)).size).toBe(1)
    expect(plano[0]!.locationId).toBe(LOCATION_IDS.plano)
  })

  it('names the program Costco Pilot under a configurable organization', async () => {
    const reference = await provider.getReferenceData()
    expect(reference.programs[0]?.name).toBe('Costco Pilot')
    expect(reference.organization.name.length).toBeGreaterThan(0)
  })

  it('seeds operational history so reporting is not empty', async () => {
    const alerts = await provider.listAlerts()
    expect(alerts.length).toBeGreaterThan(0)
    expect(alerts.some((a) => a.alert.disposition !== null)).toBe(true)
  })

  it('leaves candidates awaiting analyst review', async () => {
    const pending = await provider.listCandidates({ statuses: ['pending_review'] })
    expect(pending.length).toBeGreaterThan(0)
  })
})

describe('ingestion', () => {
  it('runs every simulator scenario without error', async () => {
    for (const scenario of SIMULATION_SCENARIOS) {
      const results = await runScenario(scenario.id)
      expect(results.length).toBeGreaterThan(0)
    }
  })

  it('matches the Stafford firearm report to Costco #1487 and scores it critical', async () => {
    const [result] = await runScenario('stafford-firearm')
    expect(result?.candidate?.locationId).toBe(LOCATION_IDS.stafford)
    expect(result?.candidate?.automatedSeverity).toBe('critical')
    expect(result?.candidate?.automatedCategoryKey).toBe('weapon_or_firearm')
    expect(result?.candidate?.status).toBe('pending_review')
    expect(result?.locationMatch?.confidence).toBeGreaterThan(80)
  })

  it('holds the customer complaint at informational', async () => {
    const [result] = await runScenario('plano-complaint')
    expect(result?.candidate?.automatedSeverity).toBe('informational')
    expect(result?.candidate?.automatedCategoryKey).toBe('customer_experience_disruption')
  })

  it('caps the reposted video at moderate', async () => {
    const [result] = await runScenario('memphis-old-repost')
    expect(result?.candidate?.automatedSeverity).toBe('moderate')
  })

  it('marks an exact repost as a duplicate and counts rewordings as corroboration', async () => {
    const results = await runScenario('stafford-duplicates')
    expect(results).toHaveLength(4)

    // The second signal is byte-identical to the first.
    expect(results[1]?.candidate?.status).toBe('duplicate')
    expect(results[1]?.duplicateFindings[0]?.method).toBe('content_hash')

    // The rewordings stay reviewable and are flagged as likely duplicates.
    expect(results[2]?.candidate?.status).toBe('pending_review')
    expect(results[2]!.duplicateFindings.length).toBeGreaterThan(0)

    // Independent accounts reporting the same event raise the score.
    expect(results[3]!.candidate!.automatedScore.breakdown.corroboration).toBeGreaterThan(
      results[0]!.candidate!.automatedScore.breakdown.corroboration,
    )
  })

  it('is idempotent for a repeated source record', async () => {
    const scenario = getScenario('stafford-firearm')!
    const input = signalInputSchema.parse(scenario.build(new Date())[0]!)

    const first = await provider.ingestSignals([input])
    const second = await provider.ingestSignals([input])

    expect(first[0]?.decision.kind).toBe('candidate_created')
    expect(second[0]?.decision.kind).toBe('rejected_duplicate_source_record')

    const signals = await provider.listSignals()
    const matching = signals.filter((s) => s.sourceRecordId === input.sourceRecordId)
    expect(matching).toHaveLength(1)
  })

  it('defaults author current location to unknown', async () => {
    const [result] = await runScenario('stafford-firearm')
    // The scenario text contains no geotag and no contemporaneous statement.
    expect(result?.candidate?.authorLocation.status).toBe('unknown')
    expect(result?.candidate?.authorLocation.evidence).toEqual([])
  })
})

describe('the complete alert lifecycle', () => {
  it('carries a simulated signal from detection to reporting', async () => {
    // 1-5. A simulated public post is ingested, matched, and scored critical.
    const [ingested] = await runScenario('stafford-firearm')
    const candidateId = ingested!.candidate!.id

    // 6. It appears in the analyst queue.
    await provider.signIn({ email: 'analyst@openiwatch.example' })
    const queue = await provider.listCandidates({ statuses: ['pending_review'] })
    expect(queue.map((c) => c.candidate.id)).toContain(candidateId)

    // 7. The analyst reviews it.
    await provider.startReview(candidateId)
    const underReview = await provider.listCandidates({ statuses: ['under_review'] })
    expect(underReview.map((c) => c.candidate.id)).toContain(candidateId)

    // 8-9. The analyst validates, which creates the operational alert.
    const { alertId } = await provider.validateCandidate(candidateId, {
      note: 'Source reviewed. Location evidence is consistent with Costco #1487.',
    })
    const alert = await provider.getAlert(alertId)
    expect(alert?.alert.status).toBe('open')
    expect(alert?.alert.severity).toBe('critical')
    expect(alert?.location.facilityNumber).toBe('1487')

    // 10. Notification deliveries are recorded for subscribed users.
    expect(alert!.deliveries.length).toBeGreaterThan(0)
    expect(alert!.alert.firstNotifiedAt).not.toBeNull()
    // In-app is always attempted first.
    expect(alert!.deliveries.some((d) => d.channel === 'in_app' && d.pathStep === 1)).toBe(true)
    // Without live credentials, the other channels are recorded as simulated.
    expect(alert!.deliveries.some((d) => d.isSimulated)).toBe(true)

    // 11. The SOC manager sees it in the feed.
    await provider.signIn({ email: 'soc.manager@openiwatch.example' })
    const feed = await provider.listAlerts({ statuses: ['open'] })
    expect(feed.map((a) => a.alert.id)).toContain(alertId)

    const inbox = await provider.listMyNotifications()
    expect(inbox.some((d) => d.alertId === alertId)).toBe(true)

    // 12. The SOC manager acknowledges.
    await provider.acknowledgeAlert(alertId, 'SOC has eyes on the feed.')
    let current = await provider.getAlert(alertId)
    expect(current?.alert.status).toBe('acknowledged')
    expect(current?.acknowledgments).toHaveLength(1)

    // 13. Regional manager and store security notification is recorded.
    await provider.escalateAlert(alertId, {
      level: 'client_regional',
      reason: 'Firearm reported on the property during trading hours.',
      notifiedParties: ['Regional manager', 'Store security'],
      storeManagerNotified: true,
      regionalManagerNotified: true,
    })
    current = await provider.getAlert(alertId)
    expect(current?.alert.status).toBe('escalated')
    expect(current?.escalations[0]?.regionalManagerNotified).toBe(true)
    expect(current?.escalations[0]?.storeManagerNotified).toBe(true)

    // 14. Assigned, resolved, dispositioned and closed.
    await provider.assignAlert(alertId, '10000000-0000-4000-8000-000000000005', 'Work the incident.')
    await provider.addComment(alertId, 'Store security confirmed police on scene.', 'operational_note')
    await provider.changeAlertStatus(alertId, 'resolved')
    await provider.setDisposition(
      alertId,
      'confirmed',
      'Police attended and detained the subject. Incident confirmed.',
    )
    await provider.changeAlertStatus(alertId, 'closed')

    current = await provider.getAlert(alertId)
    expect(current?.alert.status).toBe('closed')
    expect(current?.alert.disposition).toBe('confirmed')
    expect(current?.alert.assignedTo).toBe('10000000-0000-4000-8000-000000000005')
    expect(current?.comments).toHaveLength(1)

    // 15. Reporting reflects the completed alert.
    const report = await provider.getReport({
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
      label: 'Last 24 hours',
    })
    expect(report.alertsValidated).toBeGreaterThan(0)
    expect(report.items.map((i) => i.alert.id)).toContain(alertId)
    expect(report.escalatedIncidents).toBeGreaterThan(0)
    expect(report.averageAcknowledgmentSeconds).not.toBeNull()

    // 16. Every material action is in the audit trail.
    const actions = current!.auditTrail.map((e) => e.action)
    expect(actions).toContain('candidate_alert.review_started')
    expect(actions).toContain('candidate_alert.validated')
    expect(actions).toContain('alert.created')
    expect(actions).toContain('alert.acknowledged')
    expect(actions).toContain('alert.escalated')
    expect(actions).toContain('alert.assigned')
    expect(actions).toContain('alert.note_added')
    expect(actions).toContain('alert.disposition_set')
    expect(actions).toContain('alert.status_changed')
  })
})

describe('authorization', () => {
  it('prevents a SOC manager from validating a candidate', async () => {
    const [ingested] = await runScenario('stafford-firearm')
    await provider.signIn({ email: 'soc.manager@openiwatch.example' })
    await expect(provider.validateCandidate(ingested!.candidate!.id)).rejects.toThrow(
      /not permitted/i,
    )
  })

  it('prevents a viewer from acknowledging an alert', async () => {
    const alerts = await provider.listAlerts()
    const target = alerts.find((a) => a.alert.acknowledgedAt === null)
    if (!target) throw new Error('Expected a seeded unacknowledged alert')

    await provider.signIn({ email: 'viewer@openiwatch.example' })
    await expect(provider.acknowledgeAlert(target.alert.id, null)).rejects.toThrow(/read-only/i)
  })

  it('prevents a SOC manager from changing scoring thresholds', async () => {
    await provider.signIn({ email: 'soc.manager@openiwatch.example' })
    await expect(provider.updateThresholds({ criticalMin: 50 })).rejects.toThrow(/not permitted/i)
  })

  it('prevents an analyst from changing user roles', async () => {
    await provider.signIn({ email: 'analyst@openiwatch.example' })
    await expect(
      provider.setUserRole('10000000-0000-4000-8000-000000000006', 'program_admin'),
    ).rejects.toThrow(/not permitted/i)
  })

  it('prevents a program administrator from minting a super administrator', async () => {
    await provider.signIn({ email: 'program.admin@openiwatch.example' })
    await expect(
      provider.setUserRole('10000000-0000-4000-8000-000000000006', 'super_admin'),
    ).rejects.toThrow(/super administrator/i)
  })

  it('allows a program administrator to deactivate a threat category', async () => {
    await provider.signIn({ email: 'program.admin@openiwatch.example' })
    await provider.setCategoryActive('harassment', false)
    const reference = await provider.getReferenceData()
    expect(reference.categories.find((c) => c.key === 'harassment')?.isActive).toBe(false)
  })

  it('rejects thresholds that do not descend', async () => {
    await provider.signIn({ email: 'program.admin@openiwatch.example' })
    await expect(provider.updateThresholds({ criticalMin: 10 })).rejects.toThrow(/descend/i)
  })
})

describe('operations summary', () => {
  it('counts open alerts, unacknowledged alerts and the review backlog', async () => {
    const summary = await provider.getOperationsSummary()
    expect(summary.activeByLocation).toHaveLength(7)
    expect(summary.awaitingReview).toBeGreaterThan(0)
    expect(summary.unacknowledged).toBeGreaterThanOrEqual(0)
    expect(summary.liveFeed.length).toBeGreaterThanOrEqual(0)
  })

  it('reports a detection-to-alert latency from real timestamps', async () => {
    const summary = await provider.getOperationsSummary()
    expect(summary.medianDetectionToAlertSeconds).not.toBeNull()
    expect(summary.medianDetectionToAlertSeconds!).toBeGreaterThan(0)
  })
})
