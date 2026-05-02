import { z } from "zod"
import type { IngestionEntitlement } from "./service"

export const ingestionQueueMessageSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  customerId: z.string(),
  requestId: z.string(),
  receivedAt: z.number(),
  idempotencyKey: z.string(),
  id: z.string(),
  slug: z.string(),
  timestamp: z.number(),
  properties: z.record(z.string(), z.unknown()),
})

export type IngestionQueueMessage = z.infer<typeof ingestionQueueMessageSchema>

export type IngestionQueueRetryOptions = {
  delaySeconds?: number
}

export type IngestionQueueConsumerMessage = {
  ack: () => void
  body: IngestionQueueMessage
  retry: (options?: IngestionQueueRetryOptions) => void
}

export function partitionDuplicateQueuedMessages(messages: IngestionQueueConsumerMessage[]): {
  duplicates: IngestionQueueConsumerMessage[]
  unique: IngestionQueueConsumerMessage[]
} {
  const seen = new Set<string>()
  const duplicates: IngestionQueueConsumerMessage[] = []
  const unique: IngestionQueueConsumerMessage[] = []

  for (const message of messages) {
    const dedupeKey = [
      message.body.projectId,
      message.body.customerId,
      message.body.idempotencyKey,
    ].join(":")

    if (seen.has(dedupeKey)) {
      duplicates.push(message)
      continue
    }

    seen.add(dedupeKey)
    unique.push(message)
  }

  return {
    duplicates,
    unique,
  }
}

export function buildIngestionWindowName(params: {
  appEnv: string
  customerId: string
  customerEntitlementId: string
  projectId: string
}): string {
  return [params.appEnv, params.projectId, params.customerId, params.customerEntitlementId].join(
    ":"
  )
}

export function isIngestionEntitlementActiveAt(
  entitlement: Pick<IngestionEntitlement, "effectiveAt" | "expiresAt">,
  timestamp: number
): boolean {
  if (timestamp < entitlement.effectiveAt) {
    return false
  }

  if (typeof entitlement.expiresAt === "number" && timestamp >= entitlement.expiresAt) {
    return false
  }

  return true
}

export function filterIngestionEntitlementsWithValidAggregationPayload(params: {
  event: Pick<IngestionQueueMessage, "properties">
  entitlements: IngestionEntitlement[]
}): IngestionEntitlement[] {
  return params.entitlements.filter((entitlement) => {
    const meterConfig = entitlement.meterConfig

    if (!meterConfig) {
      return false
    }

    if (meterConfig.aggregationMethod === "count") {
      return true
    }

    const aggregationField = meterConfig.aggregationField

    if (!aggregationField) {
      return false
    }

    const value = params.event.properties[aggregationField]

    return parseFiniteAggregationValue(value) !== null
  })
}

function parseFiniteAggregationValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== "string") {
    return null
  }

  const trimmedValue = value.trim()

  if (trimmedValue.length === 0) {
    return null
  }

  const parsedValue = Number(trimmedValue)

  return Number.isFinite(parsedValue) ? parsedValue : null
}

export function sortQueuedMessages(
  left: IngestionQueueConsumerMessage,
  right: IngestionQueueConsumerMessage
): number {
  return (
    left.body.timestamp - right.body.timestamp ||
    left.body.idempotencyKey.localeCompare(right.body.idempotencyKey)
  )
}
