import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { FlaskConical, RotateCcw } from 'lucide-react'
import { signalInputSchema } from '@/services/ingestion/schema'
import { SIMULATION_SCENARIOS } from '@/simulator/scenarios'
import type { PipelineResult } from '@/services/ingestion/pipeline'
import { Badge, Button, Card, Input, Label, Select, Textarea } from '@/components/ui/primitives'
import { SeverityBadge } from '@/components/alerts/badges'
import { PageHeader } from '@/components/layout/AppShell'
import { useData } from '@/app/DataContext'
import { canValidate } from '@/data/workflow'

/**
 * Signal Simulator.
 *
 * Development-only. Generates realistic scenarios against the seeded pilot
 * locations so the complete workflow can be demonstrated without any live
 * integration. Everything it produces is marked as simulated, in the database
 * and in the interface.
 *
 * The manual submission form beneath it is NOT a simulator feature — it is the
 * real analyst submission path, one of the three Phase 1 ingestion routes.
 */

function ResultSummary({ results }: { results: PipelineResult[] }) {
  const { reference } = useData()
  if (results.length === 0) return null

  return (
    <Card className="mt-4 p-4">
      <h2 className="font-semibold">Pipeline result</h2>
      <ul className="mt-3 space-y-2">
        {results.map((result, index) => {
          const location = reference?.locations.find(
            (l) => l.id === result.candidate?.locationId,
          )
          const category = reference?.categories.find(
            (c) => c.key === result.candidate?.automatedCategoryKey,
          )

          return (
            <li key={index} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">Signal {index + 1}</Badge>
                {result.decision.kind === 'candidate_created' && result.candidate && (
                  <>
                    <SeverityBadge severity={result.candidate.automatedSeverity} />
                    <Badge variant="muted">
                      {result.candidate.automatedScore.priorityScore}/100
                    </Badge>
                    <Badge variant="secondary">{category?.label ?? 'Uncategorised'}</Badge>
                  </>
                )}
                {result.decision.kind === 'candidate_marked_duplicate' && (
                  <Badge variant="warning">Marked duplicate automatically</Badge>
                )}
                {result.decision.kind === 'rejected_duplicate_source_record' && (
                  <Badge variant="muted">
                    Already collected — idempotency prevented a second record
                  </Badge>
                )}
                {result.decision.kind === 'candidate_suppressed' && (
                  <Badge variant="muted">Auto-suppressed as non-operational</Badge>
                )}
              </div>

              <p className="mt-2 text-readable-muted">
                {location
                  ? `Matched to ${location.officialName} — ${location.city}, ${location.state} at ${result.locationMatch?.confidence ?? 0}% confidence.`
                  : 'No monitored location was matched. An analyst must assign one.'}
              </p>

              {result.duplicateFindings.length > 0 && (
                <p className="mt-1 text-[13px] text-readable-muted">
                  {result.duplicateFindings.length} similar report
                  {result.duplicateFindings.length === 1 ? '' : 's'} found (top match{' '}
                  {result.duplicateFindings[0]!.similarity}%).
                </p>
              )}

              <p className="mt-1 text-[13px] text-readable-muted">
                Author current location: {result.candidate?.authorLocation.status ?? 'unknown'}
              </p>
            </li>
          )
        })}
      </ul>

      <Button asChild variant="outline" size="sm" className="mt-3">
        <a href="/queue">Open the analyst queue</a>
      </Button>
    </Card>
  )
}

export function SimulatorPage() {
  const { provider, reference, session } = useData()
  const navigate = useNavigate()
  const [results, setResults] = React.useState<PipelineResult[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [running, setRunning] = React.useState<string | null>(null)

  const mayValidate = session ? canValidate(session.role) : false

  async function runScenario(scenarioId: string) {
    const scenario = SIMULATION_SCENARIOS.find((s) => s.id === scenarioId)
    if (!scenario) return
    setBusy(true)
    setRunning(scenarioId)
    setError(null)
    try {
      const inputs = scenario.build(new Date()).map((input) => signalInputSchema.parse(input))
      setResults(await provider.ingestSignals(inputs))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setRunning(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Signal simulator"
        description="Development tool. Generates realistic scenarios against the seeded pilot locations so the full workflow can be demonstrated without live integrations."
        actions={
          provider.resetDemoData ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setResults([])
                void provider.resetDemoData?.()
              }}
            >
              <RotateCcw className="size-3.5" />
              Reset demo data
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
        <strong className="font-semibold">Simulated content.</strong> Every signal produced here is
        stored with <code className="text-[13px]">collection_method = simulator</code> and a provenance
        statement saying it was generated, so it can never be mistaken for collected material.
        Handles are fictional and no real account or URL is referenced.
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {SIMULATION_SCENARIOS.map((scenario) => {
          const location = reference?.locations.find((l) => l.id === scenario.locationId)
          return (
            <Card key={scenario.id} className="flex flex-col p-4">
              <h2 className="font-semibold leading-snug">{scenario.title}</h2>
              <p className="mt-1 text-sm text-readable-muted">{scenario.description}</p>
              <p className="mt-2 flex-1 text-[13px] text-readable-muted">
                <span className="font-medium text-foreground">Expected: </span>
                {scenario.expectedOutcome}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {location && <Badge variant="outline">{location.officialName}</Badge>}
                <Button
                  size="sm"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => void runScenario(scenario.id)}
                >
                  <FlaskConical className="size-3.5" />
                  {running === scenario.id ? 'Running…' : 'Run scenario'}
                </Button>
              </div>
            </Card>
          )
        })}
      </div>

      <ResultSummary results={results} />

      {/* ------------------------------------------------------------------ */}
      {/* Manual analyst submission — a real ingestion path, not a simulation */}
      {/* ------------------------------------------------------------------ */}
      <Card className="mt-6 p-4">
        <h2 className="font-semibold">Manual analyst submission</h2>
        <p className="mt-1 text-sm text-readable-muted">
          This is a real ingestion path, not a simulation. A submitted item runs through the same
          validation, normalization, location matching, duplicate detection and scoring as any other
          signal.
          {!mayValidate && ' Your role cannot submit signals — only analysts and administrators can.'}
        </p>

        <form
          className="mt-4 grid gap-3 lg:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            setBusy(true)
            setError(null)
            void (async () => {
              try {
                const parsed = signalInputSchema.parse({
                  sourcePlatform: String(form.get('platform') || 'Public web source'),
                  sourceRecordId: `manual-${Date.now()}`,
                  sourceUrl: String(form.get('url') || '') || null,
                  originalText: String(form.get('text') || ''),
                  publishedAt: form.get('publishedAt')
                    ? new Date(String(form.get('publishedAt'))).toISOString()
                    : new Date().toISOString(),
                  collectionMethod: 'manual_submission',
                  provenance: `Submitted manually by ${session?.fullName ?? 'an analyst'} through the OpeniWatch interface.`,
                  author: form.get('handle')
                    ? {
                        handle: String(form.get('handle')),
                        displayName: null,
                        profileLocationText: String(form.get('profileLocation') || '') || null,
                        sourceProfileMetadata: {},
                      }
                    : null,
                  rawPayload: { submittedVia: 'manual-form' },
                })
                setResults(await provider.ingestSignals([parsed]))
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
              }
            })()
          }}
        >
          <div className="space-y-1 lg:col-span-2">
            <Label htmlFor="m-text">Original text (required)</Label>
            <Textarea
              id="m-text"
              name="text"
              required
              disabled={!mayValidate}
              placeholder="Paste the original public post, article extract or operational report verbatim."
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="m-platform">Source platform</Label>
            <Select id="m-platform" name="platform" disabled={!mayValidate}>
              <option>Public web source</option>
              <option>News / RSS</option>
              <option>Public safety feed</option>
              <option>Analyst</option>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="m-url">Source URL</Label>
            <Input
              id="m-url"
              name="url"
              type="url"
              disabled={!mayValidate}
              placeholder="https://…"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="m-handle">Public author handle</Label>
            <Input id="m-handle" name="handle" disabled={!mayValidate} placeholder="@example" />
          </div>

          <div className="space-y-1">
            <Label htmlFor="m-profile-location">Public profile location (as published)</Label>
            <Input
              id="m-profile-location"
              name="profileLocation"
              disabled={!mayValidate}
              placeholder="Houston, TX"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="m-published">Published at</Label>
            <Input
              id="m-published"
              name="publishedAt"
              type="datetime-local"
              disabled={!mayValidate}
            />
          </div>

          <div className="flex items-end gap-2">
            <Button type="submit" disabled={busy || !mayValidate}>
              Submit signal
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate('/queue')}
              disabled={!mayValidate}
            >
              Go to queue
            </Button>
          </div>
        </form>

        <p className="mt-3 text-[13px] text-readable-muted">
          The profile location field records what the source publishes about itself. It never
          establishes where the author currently is.
        </p>
      </Card>
    </div>
  )
}
