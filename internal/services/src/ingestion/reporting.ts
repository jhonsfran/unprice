import { entitlementMeterFactSchemaV1 } from "@unprice/analytics"
import { z } from "zod"
import type { IngestionQueueMessage } from "./message"

export const INGESTION_REPORTING_ENVELOPE_TARGET_BYTES = 96 * 1024

const textEncoder = new TextEncoder()

export const ingestionReportingAuditRecordSchema = z.object({
  canonicalAuditId: z.string(),
  payloadHash: z.string(),
  idempotencyKey: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  customerId: z.string(),
  environment: z.string(),
  apiKeyId: z.string().nullable(),
  sourceType: z.enum(["api_key", "system", "unknown"]),
  sourceId: z.string(),
  sourceName: z.string().nullable(),
  status: z.enum(["processed", "rejected"]),
  rejectionReason: z.string().optional(),
  firstSeenAt: z.number().int(),
  handledAt: z.number().int(),
  auditPayloadJson: z.string(),
})

// Cost tradeoff: payload drift is detected asynchronously from the append-only audit lake.
// Entitlement DO idempotency remains the correctness boundary for quota and wallet side effects.
export const ingestionReportingEnvelopeSchema = z.object({
  kind: z.literal("ingestion.reporting.v1"),
  envelopeId: z.string(),
  createdAt: z.number().int(),
  projectId: z.string(),
  customerId: z.string(),
  auditRecords: z.array(ingestionReportingAuditRecordSchema),
  meterFacts: z.array(entitlementMeterFactSchemaV1),
})

export type IngestionReportingAuditRecord = z.infer<typeof ingestionReportingAuditRecordSchema>
export type IngestionReportingEnvelope = z.infer<typeof ingestionReportingEnvelopeSchema>

export interface IngestionReportingQueueClient {
  send(envelope: IngestionReportingEnvelope): Promise<void>
}

type ReportingEnvelopeChunkItem =
  | { kind: "auditRecord"; value: IngestionReportingAuditRecord }
  | { kind: "meterFact"; value: IngestionReportingEnvelope["meterFacts"][number] }

export function chunkIngestionReportingEnvelope(
  envelope: IngestionReportingEnvelope,
  maxSerializedBytes = INGESTION_REPORTING_ENVELOPE_TARGET_BYTES
): IngestionReportingEnvelope[] {
  if (maxSerializedBytes <= 0) {
    throw new Error("maxSerializedBytes must be greater than zero")
  }

  const parsedEnvelope = ingestionReportingEnvelopeSchema.parse(envelope)
  if (serializedByteLength(parsedEnvelope) <= maxSerializedBytes) {
    return [parsedEnvelope]
  }

  const items: ReportingEnvelopeChunkItem[] = [
    ...parsedEnvelope.auditRecords.map((value) => ({ kind: "auditRecord" as const, value })),
    ...parsedEnvelope.meterFacts.map((value) => ({ kind: "meterFact" as const, value })),
  ]

  if (items.length === 0) {
    throw new Error("ingestion reporting envelope exceeds byte target without chunkable records")
  }

  const chunks: IngestionReportingEnvelope[] = []
  let currentChunk = emptyChunk(parsedEnvelope, 0)

  for (const item of items) {
    const nextChunk = appendChunkItem(currentChunk, item)

    if (serializedByteLength(nextChunk) <= maxSerializedBytes) {
      currentChunk = nextChunk
      continue
    }

    if (currentChunk.auditRecords.length > 0 || currentChunk.meterFacts.length > 0) {
      chunks.push(currentChunk)
      currentChunk = appendChunkItem(emptyChunk(parsedEnvelope, chunks.length), item)
    }

    if (serializedByteLength(currentChunk) > maxSerializedBytes) {
      throw new Error(
        `ingestion reporting envelope item exceeds byte target: ${maxSerializedBytes}`
      )
    }
  }

  if (currentChunk.auditRecords.length > 0 || currentChunk.meterFacts.length > 0) {
    chunks.push(currentChunk)
  }

  return chunks
}

export function chunkIngestionReportingEnvelopes(
  envelopes: IngestionReportingEnvelope[],
  maxSerializedBytes = INGESTION_REPORTING_ENVELOPE_TARGET_BYTES
): IngestionReportingEnvelope[] {
  return envelopes.flatMap((envelope) =>
    chunkIngestionReportingEnvelope(envelope, maxSerializedBytes)
  )
}

export function getIngestionReportingEnvelopeSerializedBytes(
  envelope: IngestionReportingEnvelope
): number {
  return serializedByteLength(ingestionReportingEnvelopeSchema.parse(envelope))
}

const RECORD_SEPARATOR = "\x1f"

export async function computeCanonicalAuditId(
  projectId: string,
  customerId: string,
  idempotencyKey: string
): Promise<string> {
  const input = [projectId, customerId, idempotencyKey].join(RECORD_SEPARATOR)
  return sha256Hex(input)
}

export async function computePayloadHash(message: IngestionQueueMessage): Promise<string> {
  const parts = [
    message.projectId,
    message.customerId,
    message.idempotencyKey,
    message.slug,
    String(message.timestamp),
    stableStringify(message.properties),
  ]

  return sha256Hex(parts.join(RECORD_SEPARATOR))
}

function emptyChunk(
  envelope: IngestionReportingEnvelope,
  chunkIndex: number
): IngestionReportingEnvelope {
  return {
    ...envelope,
    envelopeId: chunkIndex === 0 ? envelope.envelopeId : `${envelope.envelopeId}:${chunkIndex + 1}`,
    auditRecords: [],
    meterFacts: [],
  }
}

function appendChunkItem(
  envelope: IngestionReportingEnvelope,
  item: ReportingEnvelopeChunkItem
): IngestionReportingEnvelope {
  if (item.kind === "auditRecord") {
    return {
      ...envelope,
      auditRecords: [...envelope.auditRecords, item.value],
    }
  }

  return {
    ...envelope,
    meterFacts: [...envelope.meterFacts, item.value],
  }
}

function serializedByteLength(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength
}

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input)
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded)
  const hashArray = new Uint8Array(hashBuffer)
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  )

  return `{${entries
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableStringify(nestedValue)}`)
    .join(",")}}`
}
