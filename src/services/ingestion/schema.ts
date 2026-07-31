import { z } from 'zod'
import { COLLECTION_METHODS } from '@/domain/enums'

/**
 * Shared validation schema for inbound signals.
 *
 * Every ingestion path validates against this schema before anything is
 * written: the secure webhook Edge Function, manual analyst submission and the
 * development simulator. Keeping one schema means a connector cannot smuggle a
 * differently-shaped record into the pipeline.
 *
 * The Edge Function imports a Deno-side copy of these rules
 * (`supabase/functions/_shared/signal-schema.ts`) because Edge Functions cannot
 * resolve the browser `@/` alias. Both files are kept deliberately in step;
 * `signal-schema.test.ts` asserts the field lists match.
 */

const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO-8601 timestamp')

/** Only http(s) media/source URLs are accepted. */
const externalUrl = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith('http://') || value.startsWith('https://'),
    'must be an http(s) URL',
  )

export const signalAuthorInputSchema = z.object({
  /** Public handle exactly as presented by the source. */
  handle: z.string().min(1).max(200),
  displayName: z.string().max(200).nullish(),
  /**
   * Self-declared profile location. Stored as the author's PROFILE location
   * only — it never establishes where the author currently is.
   */
  profileLocationText: z.string().max(300).nullish(),
  profileUrl: externalUrl.nullish(),
  profileDescription: z.string().max(2000).nullish(),
  /** Public profile attributes exactly as supplied. Never enriched. */
  sourceProfileMetadata: z.record(z.unknown()).default({}),
})

export const signalMediaInputSchema = z.object({
  mediaType: z.enum(['image', 'video', 'document', 'audio']),
  url: externalUrl,
  thumbnailUrl: externalUrl.nullish(),
  caption: z.string().max(1000).nullish(),
  capturedAt: isoDateTime.nullish(),
})

export const signalInputSchema = z.object({
  /** Platform label, e.g. "Public web source", "RSS", "Analyst". */
  sourcePlatform: z.string().min(1).max(120),
  /** Identifier assigned by the source. Drives idempotency. */
  sourceRecordId: z.string().min(1).max(300),
  sourceUrl: externalUrl.nullish(),
  originalText: z.string().min(1).max(20_000),
  publishedAt: isoDateTime,
  collectionMethod: z.enum(COLLECTION_METHODS),
  provenance: z.string().min(1).max(1000),
  author: signalAuthorInputSchema.nullish(),
  media: z.array(signalMediaInputSchema).max(20).default([]),
  /** Coordinates supplied by the source itself, if any. */
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  /** True only when the source item carried an explicit public geotag. */
  hasPublicGeotag: z.boolean().default(false),
  language: z.string().max(20).nullish(),
  /** Verbatim source payload, retained for audit. */
  rawPayload: z.record(z.unknown()).default({}),
  /** Optional hint from an analyst or connector. Never treated as proof. */
  suggestedLocationId: z.string().uuid().nullish(),
})

export type SignalInput = z.input<typeof signalInputSchema>
export type ParsedSignalInput = z.output<typeof signalInputSchema>

export const ingestRequestSchema = z.object({
  /** Batches are capped so a single request cannot exhaust the function. */
  signals: z.array(signalInputSchema).min(1).max(50),
  /** Optional caller-supplied batch id, echoed back for reconciliation. */
  batchId: z.string().max(200).optional(),
})

export type IngestRequest = z.infer<typeof ingestRequestSchema>

/** Field list asserted against the Edge Function copy of this schema. */
export const SIGNAL_INPUT_FIELDS = Object.keys(signalInputSchema.shape).sort()
