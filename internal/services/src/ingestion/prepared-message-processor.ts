import type { Logger } from "@unprice/logs"
import type { IngestionCandidateEntitlements, IngestionEntitlement } from "./entitlement-context"
import type { IngestionEntitlementRouter } from "./entitlement-routing"
import type { EntitlementWindowApplier } from "./entitlement-window-applier"
import {
  AsyncFanoutOutcomeAccumulator,
  type FanoutMessageOutcome as MessageOutcome,
  buildMessageOutcomeKeys,
} from "./fanout-outcomes"
import type { IngestionRejectionReason } from "./interface"
import type { IngestionQueueMessage } from "./message"
import type { IngestionMessageOutcomes } from "./message-outcomes"

const DEFAULT_ENTITLEMENT_APPLY_BATCH_SIZE = 100

export class IngestionPreparedMessageProcessor {
  private readonly entitlementRouter: IngestionEntitlementRouter
  private readonly entitlementWindowApplier: EntitlementWindowApplier
  private readonly messageOutcomes: IngestionMessageOutcomes
  private readonly logger: Pick<Logger, "info">
  private readonly entitlementApplyBatchSize: number

  constructor(opts: {
    entitlementRouter: IngestionEntitlementRouter
    entitlementWindowApplier: EntitlementWindowApplier
    entitlementApplyBatchSize?: number
    logger: Pick<Logger, "info">
    messageOutcomes: IngestionMessageOutcomes
  }) {
    this.entitlementRouter = opts.entitlementRouter
    this.entitlementWindowApplier = opts.entitlementWindowApplier
    this.entitlementApplyBatchSize =
      opts.entitlementApplyBatchSize ?? DEFAULT_ENTITLEMENT_APPLY_BATCH_SIZE
    this.logger = opts.logger
    this.messageOutcomes = opts.messageOutcomes
  }

  public async process(params: {
    candidateEntitlements: IngestionCandidateEntitlements
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
    rejectionReason?: IngestionRejectionReason
  }): Promise<MessageOutcome[]> {
    const messageOutcomeKeys = buildMessageOutcomeKeys(params.messages)
    const fanoutOutcomes = this.planFanoutOutcomes(params, messageOutcomeKeys)

    this.logFanoutStats({
      customerId: params.customerId,
      fanoutOutcomes,
      messages: params.messages,
      projectId: params.projectId,
    })

    await this.applyFanoutGroups({
      customerId: params.customerId,
      fanoutOutcomes,
      messageOutcomeKeys,
      projectId: params.projectId,
    })

    const outcomes = fanoutOutcomes.toMessageOutcomes(params.messages)
    this.logRejectedOutcomes({
      customerId: params.customerId,
      outcomes,
      projectId: params.projectId,
    })

    return outcomes
  }

  private planFanoutOutcomes(
    params: {
      candidateEntitlements: IngestionCandidateEntitlements
      messages: IngestionQueueMessage[]
      rejectionReason?: IngestionRejectionReason
    },
    messageOutcomeKeys: ReadonlyMap<IngestionQueueMessage, string>
  ): AsyncFanoutOutcomeAccumulator<IngestionEntitlement> {
    const fanoutOutcomes = new AsyncFanoutOutcomeAccumulator<IngestionEntitlement>(
      messageOutcomeKeys
    )

    for (const message of params.messages) {
      if (params.rejectionReason) {
        fanoutOutcomes.rejectMessage(message, params.rejectionReason)
        continue
      }

      const processableEntitlementsResult = this.entitlementRouter.resolveProcessableEntitlements({
        candidateEntitlements: params.candidateEntitlements,
        message,
      })

      if (processableEntitlementsResult.err) {
        fanoutOutcomes.rejectMessage(message, processableEntitlementsResult.err)
        continue
      }

      fanoutOutcomes.planEntitlementApplies(message, processableEntitlementsResult.val)
    }

    return fanoutOutcomes
  }

  private logFanoutStats(params: {
    customerId: string
    fanoutOutcomes: AsyncFanoutOutcomeAccumulator<IngestionEntitlement>
    messages: IngestionQueueMessage[]
    projectId: string
  }): void {
    const { customerId, fanoutOutcomes, messages, projectId } = params
    const fanoutStats = fanoutOutcomes.getFanoutStats()
    this.logger.info("raw ingestion entitlement fanout", {
      projectId,
      customerId,
      raw_event_count: messages.length,
      matched_entitlement_count: fanoutStats.matchedEntitlementCount,
      matched_entitlements_per_event_max: fanoutStats.matchedEntitlementsPerEventMax,
      apply_group_count: fanoutStats.applyGroupCount,
    })
  }

  private async applyFanoutGroups(params: {
    customerId: string
    fanoutOutcomes: AsyncFanoutOutcomeAccumulator<IngestionEntitlement>
    messageOutcomeKeys: ReadonlyMap<IngestionQueueMessage, string>
    projectId: string
  }): Promise<void> {
    const { customerId, fanoutOutcomes, messageOutcomeKeys, projectId } = params
    for (const group of fanoutOutcomes.getApplyGroups()) {
      for (const chunk of chunkArray(group.messages, this.entitlementApplyBatchSize)) {
        const batchResults = await this.entitlementWindowApplier.applyBatch({
          customerId,
          enforceLimit: false,
          entitlement: group.entitlement,
          messageOutcomeKeys,
          messages: chunk,
          projectId,
        })

        for (const applyResult of batchResults) {
          fanoutOutcomes.recordApplyResult(applyResult)
        }
      }
    }
  }

  private logRejectedOutcomes(params: {
    customerId: string
    outcomes: MessageOutcome[]
    projectId: string
  }): void {
    const { customerId, outcomes, projectId } = params
    for (const { message, outcome } of outcomes) {
      if (outcome.state !== "rejected") {
        continue
      }

      this.messageOutcomes.logRejectedMessage({
        customerId,
        message,
        projectId,
        rejectionReason: outcome.rejectionReason,
      })
    }
  }
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}
