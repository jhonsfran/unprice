import type { AnalyticsEntitlementMeterFact } from "@unprice/analytics"
import type { IngestionOutcome, IngestionRejectionReason } from "./interface"
import type { IngestionQueueMessage } from "./message"

export type FanoutMessageOutcome = {
  meterFacts?: AnalyticsEntitlementMeterFact[]
  message: IngestionQueueMessage
  outcome: IngestionOutcome
}

export type FanoutApplyGroup<TEntitlement extends { customerEntitlementId: string }> = {
  entitlement: TEntitlement
  messages: IngestionQueueMessage[]
}

export type FanoutApplyResult = {
  allowed: boolean
  correlationKey: string
  deniedReason?: IngestionRejectionReason
  meterFacts?: AnalyticsEntitlementMeterFact[]
}

export class AsyncFanoutOutcomeAccumulator<TEntitlement extends { customerEntitlementId: string }> {
  private readonly allowedApplyCountsByKey = new Map<string, number>()
  private readonly applyGroups = new Map<string, FanoutApplyGroup<TEntitlement>>()
  private readonly deniedReasonsByKey = new Map<string, IngestionRejectionReason>()
  private readonly lateClosedApplyCountsByKey = new Map<string, number>()
  private readonly messageKeys = new Set<string>()
  private readonly meterFactsByKey = new Map<string, AnalyticsEntitlementMeterFact[]>()
  private readonly outcomesByKey = new Map<string, IngestionOutcome>()
  private readonly plannedApplyCountsByKey = new Map<string, number>()
  private matchedEntitlementCount = 0
  private matchedEntitlementsPerEventMax = 0

  constructor(private readonly messageOutcomeKeys: ReadonlyMap<IngestionQueueMessage, string>) {}

  public rejectMessage(
    message: IngestionQueueMessage,
    rejectionReason: IngestionRejectionReason
  ): void {
    const messageKey = this.registerMessage(message)
    this.outcomesByKey.set(messageKey, { state: "rejected", rejectionReason })
  }

  public planEntitlementApplies(
    message: IngestionQueueMessage,
    entitlements: TEntitlement[]
  ): void {
    const messageKey = this.registerMessage(message)

    this.outcomesByKey.set(messageKey, { state: "processed" })
    this.allowedApplyCountsByKey.set(messageKey, 0)
    this.plannedApplyCountsByKey.set(messageKey, entitlements.length)
    this.lateClosedApplyCountsByKey.set(messageKey, 0)
    this.matchedEntitlementCount += entitlements.length
    this.matchedEntitlementsPerEventMax = Math.max(
      this.matchedEntitlementsPerEventMax,
      entitlements.length
    )

    for (const entitlement of entitlements) {
      const group = this.applyGroups.get(entitlement.customerEntitlementId)

      if (group) {
        group.messages.push(message)
        continue
      }

      this.applyGroups.set(entitlement.customerEntitlementId, {
        entitlement,
        messages: [message],
      })
    }
  }

  public getApplyGroups(): FanoutApplyGroup<TEntitlement>[] {
    return [...this.applyGroups.values()]
  }

  public getFanoutStats(): {
    applyGroupCount: number
    matchedEntitlementCount: number
    matchedEntitlementsPerEventMax: number
  } {
    return {
      applyGroupCount: this.applyGroups.size,
      matchedEntitlementCount: this.matchedEntitlementCount,
      matchedEntitlementsPerEventMax: this.matchedEntitlementsPerEventMax,
    }
  }

  public recordApplyResult(applyResult: FanoutApplyResult): void {
    if (!this.messageKeys.has(applyResult.correlationKey)) {
      return
    }

    if (applyResult.allowed) {
      this.increment(this.allowedApplyCountsByKey, applyResult.correlationKey)
      this.appendMeterFacts(applyResult.correlationKey, applyResult.meterFacts ?? [])
      return
    }

    if (applyResult.deniedReason === "LATE_EVENT_CLOSED_PERIOD") {
      this.increment(this.lateClosedApplyCountsByKey, applyResult.correlationKey)
      return
    }

    if (applyResult.deniedReason) {
      this.deniedReasonsByKey.set(applyResult.correlationKey, applyResult.deniedReason)
    }
  }

  public toMessageOutcomes(messages: IngestionQueueMessage[]): FanoutMessageOutcome[] {
    this.rejectMessagesWithoutAllowedApply()

    return messages.map((message) => {
      const messageKey = getMessageOutcomeKey(message, this.messageOutcomeKeys)

      return {
        message,
        meterFacts: this.meterFactsByKey.get(messageKey),
        outcome: this.outcomesByKey.get(messageKey) ?? { state: "processed" },
      }
    })
  }

  private registerMessage(message: IngestionQueueMessage): string {
    const messageKey = getMessageOutcomeKey(message, this.messageOutcomeKeys)
    this.messageKeys.add(messageKey)
    return messageKey
  }

  private appendMeterFacts(messageKey: string, meterFacts: AnalyticsEntitlementMeterFact[]): void {
    if (meterFacts.length === 0) {
      return
    }

    const existingFacts = this.meterFactsByKey.get(messageKey) ?? []
    existingFacts.push(...meterFacts)
    this.meterFactsByKey.set(messageKey, existingFacts)
  }

  private increment(map: Map<string, number>, messageKey: string): void {
    map.set(messageKey, (map.get(messageKey) ?? 0) + 1)
  }

  private rejectMessagesWithoutAllowedApply(): void {
    for (const [messageKey, plannedApplyCount] of this.plannedApplyCountsByKey.entries()) {
      const allowedCount = this.allowedApplyCountsByKey.get(messageKey) ?? 0
      const lateClosedCount = this.lateClosedApplyCountsByKey.get(messageKey) ?? 0

      if (plannedApplyCount === 0 || allowedCount > 0) {
        continue
      }

      this.outcomesByKey.set(messageKey, {
        state: "rejected",
        rejectionReason:
          this.deniedReasonsByKey.get(messageKey) ??
          (lateClosedCount === plannedApplyCount ? "LATE_EVENT_CLOSED_PERIOD" : "LIMIT_EXCEEDED"),
      })
    }
  }
}

export function buildMessageOutcomeKeys(
  messages: IngestionQueueMessage[]
): Map<IngestionQueueMessage, string> {
  return new Map(
    messages.map((message, index) => [message, `${buildMessageOutcomeKey(message)}:${index}`])
  )
}

export function getMessageOutcomeKey(
  message: IngestionQueueMessage,
  keys: ReadonlyMap<IngestionQueueMessage, string>
): string {
  const key = keys.get(message)
  if (!key) {
    throw new Error(`missing ingestion message outcome key: ${message.idempotencyKey}`)
  }
  return key
}

function buildMessageOutcomeKey(message: IngestionQueueMessage): string {
  return `${message.idempotencyKey}:${message.id}`
}
