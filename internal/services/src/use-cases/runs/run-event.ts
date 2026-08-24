import type { MeterConfig, RunLedgerSummary } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { BudgetRunService } from "../../budget-runs"
import type {
  IngestionEntitlement,
  IngestionGrant,
  IngestionOutcome,
  IngestionQueueMessage,
  IngestionRejectionReason,
  IngestionReportingOutcomeDispatcher,
} from "../../ingestion"
import type { RunBudgetSummary, RunSyncDecision } from "./run-budget-client"
import { RunUseCaseError } from "./start-run"

export type RunEntitlementResolver = {
  resolveForFeature(params: {
    projectId: string
    customerId: string
    featureSlug: string
    eventSlug: string
    eventTimestamp: number
    eventProperties: Record<string, unknown>
  }): Promise<RunEntitlementResolution>
}

export type RunEntitlementResolution =
  | {
      ok: true
      entitlement: IngestionEntitlement & { meterConfig: MeterConfig }
      grants: IngestionGrant[]
    }
  | { ok: false; reason: IngestionRejectionReason }

export type RunEventInput = {
  projectId: string
  runId: string
  keyCustomerId: string | null
  featureSlug: string
  idempotencyKey: string
  requestId: string
  receivedAt: number
  event: {
    id: string
    slug: string
    timestamp: number
    properties: Record<string, unknown>
  }
  source: {
    workspaceId: string
    environment: string
    apiKeyId: string | null
    sourceType: "api_key" | "system" | "unknown"
    sourceId: string
    sourceName: string | null
  }
  now: number
}

export type RunRecord = NonNullable<Awaited<ReturnType<BudgetRunService["getRun"]>>["val"]>

export async function loadAccessibleRun(
  budgetRuns: BudgetRunService,
  input: Pick<RunEventInput, "keyCustomerId" | "projectId" | "runId">
): Promise<Result<RunRecord, RunUseCaseError>> {
  const result = await budgetRuns.getRun({ projectId: input.projectId, runId: input.runId })
  if (result.err || !canAccessRun(input.keyCustomerId, result.val.customerId)) {
    return Err(new RunUseCaseError("RUN_NOT_FOUND"))
  }
  return Ok(result.val)
}

export function resolveRunEntitlement(
  resolver: RunEntitlementResolver,
  run: RunRecord,
  input: Pick<RunEventInput, "event" | "featureSlug">
): Promise<RunEntitlementResolution> {
  return resolver.resolveForFeature({
    projectId: run.projectId,
    customerId: run.customerId,
    featureSlug: input.featureSlug,
    eventSlug: input.event.slug,
    eventTimestamp: input.event.timestamp,
    eventProperties: input.event.properties,
  })
}

export async function updateRunFromDecision(input: {
  budgetRuns: BudgetRunService
  decision: RunSyncDecision
  run: RunRecord
  status: RunLedgerSummary["status"]
}): Promise<Result<{ endedAt: number | null }, RunUseCaseError>> {
  const { budgetRuns, decision, run, status } = input
  const statusReason = decision.allowed ? null : (decision.rejectionReason ?? "RUN_BUDGET_EXCEEDED")

  if (status === "running") {
    const update = await budgetRuns.updateRunSummary({
      projectId: run.projectId,
      runId: run.id,
      status,
      statusReason,
      consumedAmount: decision.budget.consumedAmount,
      remainingAmount: decision.budget.remainingAmount,
      endedAt: null,
    })
    return update.err ? Err(new RunUseCaseError("BUDGET_ERROR")) : Ok({ endedAt: null })
  }

  const endedAt = decision.budget.endedAt
  if (endedAt == null) return Err(new RunUseCaseError("BUDGET_ERROR"))

  const update = await budgetRuns.updateRunSummary({
    projectId: run.projectId,
    runId: run.id,
    status,
    statusReason,
    consumedAmount: decision.budget.consumedAmount,
    remainingAmount: decision.budget.remainingAmount,
    endedAt: new Date(endedAt),
  })
  return update.err ? Err(new RunUseCaseError("BUDGET_ERROR")) : Ok({ endedAt })
}

export async function reportRunDecision(input: {
  decision: RunSyncDecision
  event: RunEventInput
  reportingDispatcher: IngestionReportingOutcomeDispatcher
  run: RunRecord
}): Promise<void> {
  const outcome: IngestionOutcome = input.decision.allowed
    ? { state: "processed" }
    : {
        state: "rejected",
        rejectionReason: input.decision.rejectionReason ?? "RUN_BUDGET_EXCEEDED",
      }
  await enqueueRunOutcome({
    event: input.event,
    meterFacts: input.decision.meterFacts,
    outcome,
    reportingDispatcher: input.reportingDispatcher,
    run: input.run,
  })
}

export async function reportRunRejection(input: {
  event: RunEventInput
  reason: IngestionRejectionReason
  reportingDispatcher: IngestionReportingOutcomeDispatcher
  run: RunRecord
}): Promise<void> {
  await enqueueRunOutcome({
    event: input.event,
    meterFacts: [],
    outcome: { state: "rejected", rejectionReason: input.reason },
    reportingDispatcher: input.reportingDispatcher,
    run: input.run,
  })
}

export function toPublicRun(
  run: RunRecord,
  budget: RunBudgetSummary,
  status: RunLedgerSummary["status"] = budget.status
): RunLedgerSummary {
  return {
    runId: run.id,
    status,
    endedAt: budget.endedAt ?? null,
    customerId: run.customerId,
    budgetAmount: budget.budgetAmount,
    consumedAmount: budget.consumedAmount,
    remainingAmount: budget.remainingAmount,
    currency: run.currency,
    workloadType: run.workloadType,
    workloadId: run.workloadId,
    traceId: run.traceId,
    parentRunId: run.parentRunId,
  }
}

export function toStoredPublicRun(run: RunRecord): RunLedgerSummary {
  return {
    runId: run.id,
    status: run.status,
    endedAt: run.endedAt?.getTime() ?? null,
    customerId: run.customerId,
    budgetAmount: run.budgetAmount,
    consumedAmount: run.consumedAmount,
    remainingAmount: run.remainingAmount,
    currency: run.currency,
    workloadType: run.workloadType,
    workloadId: run.workloadId,
    traceId: run.traceId,
    parentRunId: run.parentRunId,
  }
}

export function mapEntitlementRejection(
  reason: IngestionRejectionReason
): "insufficient_budget" | "expired" | "not_running" | "entitlement_denied" {
  switch (reason) {
    case "EVENT_TOO_OLD":
    case "LATE_EVENT_CLOSED_PERIOD":
      return "expired"
    default:
      return "entitlement_denied"
  }
}

export function mapRunRejection(
  reason?: string
): "insufficient_budget" | "expired" | "not_running" | "entitlement_denied" {
  switch (reason) {
    case "RUN_BUDGET_EXCEEDED":
    case "WALLET_EMPTY":
      return "insufficient_budget"
    case "LIMIT_EXCEEDED":
      return "entitlement_denied"
    case "LATE_EVENT_CLOSED_PERIOD":
      return "expired"
    default:
      return "not_running"
  }
}

function canAccessRun(keyCustomerId: string | null, runCustomerId: string): boolean {
  return keyCustomerId === null || keyCustomerId === runCustomerId
}

async function enqueueRunOutcome(input: {
  event: RunEventInput
  meterFacts: RunSyncDecision["meterFacts"]
  outcome: IngestionOutcome
  reportingDispatcher: IngestionReportingOutcomeDispatcher
  run: RunRecord
}): Promise<void> {
  await input.reportingDispatcher.enqueueOutcomes({
    customerId: input.run.customerId,
    projectId: input.run.projectId,
    outcomes: [
      {
        message: buildRunReportingMessage(input.event, input.run),
        outcome: input.outcome,
        meterFacts: input.meterFacts,
      },
    ],
  })
}

function buildRunReportingMessage(input: RunEventInput, run: RunRecord): IngestionQueueMessage {
  return {
    version: 1,
    workspaceId: input.source.workspaceId,
    projectId: run.projectId,
    customerId: run.customerId,
    requestId: input.requestId,
    receivedAt: input.receivedAt,
    idempotencyKey: input.idempotencyKey,
    id: input.event.id,
    slug: input.event.slug,
    timestamp: input.event.timestamp,
    properties: input.event.properties,
    source: input.source,
    ingestionMode: "run",
    runContext: {
      runId: run.id,
      traceId: run.traceId,
      parentRunId: run.parentRunId,
      workloadType: run.workloadType,
      workloadId: run.workloadId,
    },
  }
}
