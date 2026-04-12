import type { IngestionQueueMessage } from "./message"

export type IngestionAuditEntry = {
  auditPayloadJson: string
  canonicalAuditId: string
  firstSeenAt: number
  idempotencyKey: string
  payloadHash: string
  rejectionReason?: string
  resultJson: string
  status: "processed" | "rejected"
}

export type IngestionAuditCommitResult = {
  conflicts: number
  duplicates: number
  inserted: number
}

export type IngestionAuditController = {
  commit: (entries: IngestionAuditEntry[]) => Promise<IngestionAuditCommitResult>
  exists: (idempotencyKeys: string[]) => Promise<string[]>
}

export interface IngestionAuditClient {
  getAuditStub(params: {
    customerId: string
    projectId: string
    shardIndex: number
  }): IngestionAuditController
}

const RECORD_SEPARATOR = "\x1f"
export const INGESTION_AUDIT_SHARD_COUNT = 32

export function selectIngestionAuditShardIndex(
  idempotencyKey: string,
  shardCount = INGESTION_AUDIT_SHARD_COUNT
): number {
  let hash = 0

  for (let index = 0; index < idempotencyKey.length; index++) {
    hash = (hash * 31 + idempotencyKey.charCodeAt(index)) >>> 0
  }

  return hash % shardCount
}

export function buildIngestionAuditShardName(params: {
  appEnv: string
  customerId: string
  projectId: string
  shardIndex: number
}): string {
  return ["audit", params.appEnv, params.projectId, params.customerId, params.shardIndex].join(":")
}

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
