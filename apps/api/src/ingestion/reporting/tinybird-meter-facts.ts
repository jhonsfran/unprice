import {
  type AnalyticsEntitlementMeterFact,
  entitlementMeterFactSchemaV1,
} from "@unprice/analytics"

const TINYBIRD_MAX_FACTS_PER_REQUEST = 5_000
const TINYBIRD_MAX_NDJSON_BYTES_PER_REQUEST = 5 * 1024 * 1024

const textEncoder = new TextEncoder()

export type TinybirdIngestResult = {
  quarantined_rows?: number
  successful_rows?: number
}

export type MeterFactIngest = (
  facts: AnalyticsEntitlementMeterFact[]
) => Promise<TinybirdIngestResult | undefined>

export function chunkMeterFactsForTinybird(
  facts: AnalyticsEntitlementMeterFact[],
  limits: {
    maxFactsPerRequest?: number
    maxNdjsonBytesPerRequest?: number
  } = {}
): AnalyticsEntitlementMeterFact[][] {
  const maxFactsPerRequest = limits.maxFactsPerRequest ?? TINYBIRD_MAX_FACTS_PER_REQUEST
  const maxNdjsonBytesPerRequest =
    limits.maxNdjsonBytesPerRequest ?? TINYBIRD_MAX_NDJSON_BYTES_PER_REQUEST

  if (maxFactsPerRequest <= 0 || maxNdjsonBytesPerRequest <= 0) {
    throw new Error("Tinybird chunk limits must be greater than zero")
  }

  const chunks: AnalyticsEntitlementMeterFact[][] = []
  let currentChunk: AnalyticsEntitlementMeterFact[] = []
  let currentChunkBytes = 0

  for (const fact of facts) {
    const parsedFact = entitlementMeterFactSchemaV1.parse(fact)
    const factBytes = ndjsonByteLength(parsedFact)

    if (factBytes > maxNdjsonBytesPerRequest) {
      throw new Error(
        `Tinybird entitlement meter fact exceeds NDJSON byte limit: ${maxNdjsonBytesPerRequest}`
      )
    }

    const nextChunkWouldExceedCount = currentChunk.length >= maxFactsPerRequest
    const nextChunkWouldExceedBytes =
      currentChunk.length > 0 && currentChunkBytes + factBytes > maxNdjsonBytesPerRequest

    if (nextChunkWouldExceedCount || nextChunkWouldExceedBytes) {
      chunks.push(currentChunk)
      currentChunk = []
      currentChunkBytes = 0
    }

    currentChunk.push(parsedFact)
    currentChunkBytes += factBytes
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk)
  }

  return chunks
}

export async function publishMeterFactChunks(
  chunks: AnalyticsEntitlementMeterFact[][],
  ingestMeterFacts: MeterFactIngest
): Promise<void> {
  for (const chunk of chunks) {
    const result = await ingestMeterFacts(chunk)
    const successful = result?.successful_rows ?? 0
    const quarantined = result?.quarantined_rows ?? 0

    if (successful !== chunk.length || quarantined !== 0) {
      throw new Error(
        `Tinybird entitlement meter facts ingestion failed: expected=${chunk.length} successful=${successful} quarantined=${quarantined}`
      )
    }
  }
}

function ndjsonByteLength(value: unknown): number {
  return textEncoder.encode(`${JSON.stringify(value)}\n`).byteLength
}
