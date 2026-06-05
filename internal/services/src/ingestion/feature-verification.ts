import type { Logger } from "@unprice/logs"
import { formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"
import type {
  CustomerGrantContextReader,
  IngestionEntitlement,
  IngestionGrant,
  PreparedCustomerGrantContext,
} from "./entitlement-context"
import { resolveCustomerGrantContextWindow } from "./entitlement-context"
import type { EntitlementWindowClient } from "./entitlement-window-applier"
import type { EntitlementWindowState, FeatureVerificationResult } from "./interface"
import { isIngestionEntitlementActiveAt } from "./message"

type VerifyFeatureStatusInput = {
  customerId: string
  featureSlug: string
  projectId: string
  timestamp: number
}

type FeatureEntitlementMatch =
  | { kind: "matched"; entitlement: IngestionEntitlement }
  | { kind: "rejected"; result: FeatureVerificationResult }

export class IngestionFeatureVerifier {
  private readonly entitlementContext: CustomerGrantContextReader
  private readonly entitlementWindowClient: EntitlementWindowClient
  private readonly logger: Pick<Logger, "error">

  constructor(opts: {
    entitlementContext: CustomerGrantContextReader
    entitlementWindowClient: EntitlementWindowClient
    logger: Pick<Logger, "error">
  }) {
    this.entitlementContext = opts.entitlementContext
    this.entitlementWindowClient = opts.entitlementWindowClient
    this.logger = opts.logger
  }

  public async verifyFeatureStatus(
    params: VerifyFeatureStatusInput
  ): Promise<FeatureVerificationResult> {
    const { customerId, featureSlug, projectId, timestamp } = params
    const preparedContext = await this.entitlementContext.prepareCustomerGrantContext({
      customerId,
      projectId,
      ...resolveCustomerGrantContextWindow({
        earliestTimestamp: timestamp,
        latestTimestamp: timestamp,
      }),
    })

    const contextRejection = resolvePreparedContextRejection({
      featureSlug,
      rejectionReason: preparedContext.rejectionReason,
    })
    if (contextRejection) {
      return contextRejection
    }

    const match = this.resolveFeatureEntitlementMatch({
      candidateEntitlements: preparedContext.candidateEntitlements,
      customerId,
      featureSlug,
      projectId,
      timestamp,
    })
    if (match.kind === "rejected") {
      return match.result
    }

    const entitlement = match.entitlement

    if (isStaticQuantityEntitlement(entitlement)) {
      return {
        allowed: true,
        featureSlug,
        limit: resolveStaticQuantityLimit(entitlement.grants, timestamp),
      }
    }

    if (entitlement.featureType !== "usage") {
      return {
        allowed: true,
        featureSlug,
      }
    }

    return this.verifyUsageEntitlement({
      customerId,
      entitlement,
      featureSlug,
      projectId,
      timestamp,
    })
  }

  private resolveFeatureEntitlementMatch(params: {
    candidateEntitlements: IngestionEntitlement[]
    customerId: string
    featureSlug: string
    projectId: string
    timestamp: number
  }): FeatureEntitlementMatch {
    const { candidateEntitlements, customerId, featureSlug, projectId, timestamp } = params
    const matchingEntitlements = candidateEntitlements.filter(
      (candidate) =>
        candidate.featureSlug === featureSlug &&
        isIngestionEntitlementActiveAt(candidate, timestamp)
    )

    if (matchingEntitlements.length > 1) {
      this.logger.error("multiple active entitlements matched feature verification", {
        projectId,
        customerId,
        featureSlug,
        customerEntitlementIds: matchingEntitlements.map(
          (entitlement) => entitlement.customerEntitlementId
        ),
      })

      return {
        kind: "rejected",
        result: {
          allowed: false,
          featureSlug,
          rejectionReason: "INVALID_ENTITLEMENT_CONFIGURATION",
        },
      }
    }

    const entitlement = matchingEntitlements[0]

    if (!entitlement) {
      return {
        kind: "rejected",
        result: {
          allowed: false,
          featureSlug,
          rejectionReason: "NO_MATCHING_ENTITLEMENT",
        },
      }
    }

    return { kind: "matched", entitlement }
  }

  private async verifyUsageEntitlement(params: {
    customerId: string
    entitlement: IngestionEntitlement
    featureSlug: string
    projectId: string
    timestamp: number
  }): Promise<FeatureVerificationResult> {
    const { customerId, entitlement, featureSlug, projectId, timestamp } = params
    if (!entitlement.meterConfig) {
      return {
        allowed: false,
        featureSlug,
        message: "Usage feature is missing meter configuration",
        rejectionReason: "INVALID_ENTITLEMENT_CONFIGURATION",
      }
    }

    const applyEntitlement = {
      ...entitlement,
      meterConfig: entitlement.meterConfig,
    }
    const enforcementState = await this.entitlementWindowClient
      .getEntitlementWindowStub({
        customerEntitlementId: entitlement.customerEntitlementId,
        customerId,
        projectId,
      })
      .getEnforcementState({
        entitlement: applyEntitlement,
        grants: entitlement.grants,
        now: timestamp,
      })

    return {
      allowed: !enforcementState.isLimitReached,
      featureSlug,
      limit: enforcementState.limit,
      rejectionReason: enforcementState.isLimitReached ? "LIMIT_EXCEEDED" : undefined,
      spending: formatVerificationSpending(enforcementState.spending),
      usage: enforcementState.usage,
    }
  }
}

function resolvePreparedContextRejection(params: {
  featureSlug: string
  rejectionReason: PreparedCustomerGrantContext["rejectionReason"]
}): FeatureVerificationResult | null {
  const { featureSlug, rejectionReason } = params
  if (!rejectionReason || rejectionReason === "NO_MATCHING_ENTITLEMENT") {
    return null
  }

  return {
    allowed: false,
    featureSlug,
    rejectionReason,
  }
}

function isStaticQuantityEntitlement(entitlement: IngestionEntitlement): boolean {
  return entitlement.featureType === "tier" || entitlement.featureType === "package"
}

function resolveStaticQuantityLimit(grants: IngestionGrant[], timestamp: number): number | null {
  const activeGrants = grants.filter(
    (grant) =>
      grant.effectiveAt <= timestamp && (grant.expiresAt === null || timestamp < grant.expiresAt)
  )

  if (activeGrants.length === 0 || activeGrants.some((grant) => grant.allowanceUnits === null)) {
    return null
  }

  return activeGrants.reduce((total, grant) => total + (grant.allowanceUnits ?? 0), 0)
}

function formatVerificationSpending(spending: EntitlementWindowState["spending"]) {
  const amount = toDecimal(fromLedgerMinor(spending.ledgerAmount, spending.currency))

  return {
    currency: spending.currency,
    displayAmount: formatMoney(amount, spending.currency),
    ledgerAmount: spending.ledgerAmount,
    scale: spending.scale,
  }
}
