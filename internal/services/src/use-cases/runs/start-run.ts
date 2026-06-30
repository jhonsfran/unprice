import type { RunLedgerSummary } from "@unprice/db/validators"
import { BaseError, Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { fromCurrencyMinor, toLedgerMinor } from "@unprice/money"
import type { BudgetRunService } from "../../budget-runs"
import type { CustomerService } from "../../customers/service"
import { type SyncCatchUpService, ensureSubscriptionRenewed } from "../../subscriptions"
import type { RunBudgetClient } from "./run-budget-client"

type RunWorkloadType = "agent" | "workflow" | "job" | "tool" | "custom"

export class RunUseCaseError extends BaseError {
  public readonly retry = false
  public readonly name = "RunUseCaseError"

  constructor(
    message:
      | "RUN_NOT_FOUND"
      | "CUSTOMER_NOT_FOUND"
      | "SUBSCRIPTION_REQUIRED"
      | "BUDGET_ERROR"
      | "WALLET_EMPTY"
  ) {
    super({ message })
  }
}

export type StartRunResolvedInput = {
  projectId: string
  customerId: string
  budgetAmount: number
  currency: string
  idempotencyKey: string
  workloadType?: RunWorkloadType | null
  workloadId?: string | null
  traceId?: string | null
  parentRunId?: string | null
  metadata?: Record<string, unknown>
  expiresAt?: number | null
}

export type StartRunDeps = {
  services: Pick<{ budgetRuns: BudgetRunService }, "budgetRuns">
  runBudget: RunBudgetClient
  logger?: Logger
}

export type StartRunForCustomerSubscriptionInput = Omit<
  StartRunResolvedInput,
  "budgetAmount" | "currency"
> & {
  budgetAmountCurrencyMinor: number
}

export type StartRunForCustomerSubscriptionDeps = {
  services: {
    budgetRuns: BudgetRunService
    customer: Pick<CustomerService, "getActiveSubscription">
    subscription: SyncCatchUpService
  }
  runBudget: RunBudgetClient
  logger?: Pick<Logger, "info" | "warn">
  now?: () => number
}

const noopSubscriptionLogger: Pick<Logger, "info" | "warn"> = {
  info: () => {},
  warn: () => {},
}

export async function startRunForCustomerSubscription(
  deps: StartRunForCustomerSubscriptionDeps,
  input: StartRunForCustomerSubscriptionInput
): Promise<Result<RunLedgerSummary, RunUseCaseError>> {
  const now = deps.now?.() ?? Date.now()
  const subscriptionResult = await deps.services.customer.getActiveSubscription({
    customerId: input.customerId,
    projectId: input.projectId,
    now,
  })

  const subscription = subscriptionResult.val
  const activePhase = subscription?.activePhase

  if (subscriptionResult.err || !subscription || !activePhase) {
    return Err(new RunUseCaseError("SUBSCRIPTION_REQUIRED"))
  }

  await ensureSubscriptionRenewed(
    {
      subscriptions: deps.services.subscription,
      logger: deps.logger ?? noopSubscriptionLogger,
    },
    {
      subscriptionId: subscription.id,
      projectId: input.projectId,
      now,
    }
  )

  const currency = activePhase.planVersion.currency
  const budgetAmount = toLedgerMinor(fromCurrencyMinor(input.budgetAmountCurrencyMinor, currency))

  return startRun(
    {
      services: { budgetRuns: deps.services.budgetRuns },
      runBudget: deps.runBudget,
    },
    {
      ...input,
      budgetAmount,
      currency,
    }
  )
}

export async function startRun(
  deps: StartRunDeps,
  input: StartRunResolvedInput
): Promise<Result<RunLedgerSummary, RunUseCaseError>> {
  // 1. Create or fetch the Postgres budget_runs row by idempotency key
  const createResult = await deps.services.budgetRuns.createRun({
    projectId: input.projectId,
    customerId: input.customerId,
    budgetAmount: input.budgetAmount,
    remainingAmount: input.budgetAmount,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    workloadType: input.workloadType,
    workloadId: input.workloadId,
    traceId: input.traceId,
    parentRunId: input.parentRunId,
    metadata: input.metadata,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
  })

  if (createResult.err) {
    return Err(new RunUseCaseError("BUDGET_ERROR"))
  }

  const run = createResult.val

  if (run.status === "failed") {
    return Err(
      new RunUseCaseError(run.statusReason?.startsWith("wallet:") ? "WALLET_EMPTY" : "BUDGET_ERROR")
    )
  }

  // 2. Call RunBudgetDO with the canonical run id
  const doResult = await deps.runBudget.startRun({
    projectId: input.projectId,
    customerId: input.customerId,
    runId: run.id,
    budgetAmount: input.budgetAmount,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    workloadType: input.workloadType,
    workloadId: input.workloadId,
    traceId: input.traceId,
    parentRunId: input.parentRunId,
    metadata: input.metadata,
    expiresAt: input.expiresAt,
  })

  if (doResult.err) {
    // Mark the Postgres row as failed so it doesn't sit orphaned in "running"
    const updateResult = await deps.services.budgetRuns.updateRunSummary({
      projectId: input.projectId,
      runId: run.id,
      status: "failed",
      statusReason: `DO error: ${doResult.err.message}`,
      consumedAmount: 0,
      remainingAmount: 0,
      endedAt: new Date(),
    })
    if (updateResult.err) {
      return Err(new RunUseCaseError("BUDGET_ERROR"))
    }
    return Err(new RunUseCaseError("BUDGET_ERROR"))
  }

  // Check if the DO reported a wallet error (e.g. WALLET_EMPTY)
  const summary = doResult.val.summary
  if (summary.status === "failed" && doResult.val.walletError) {
    // Mark the Postgres row as failed before returning the business error
    const updateResult = await deps.services.budgetRuns.updateRunSummary({
      projectId: input.projectId,
      runId: run.id,
      status: "failed",
      statusReason: `wallet: ${doResult.val.walletError}`,
      consumedAmount: 0,
      remainingAmount: 0,
      endedAt: new Date(),
    })
    if (updateResult.err) {
      return Err(new RunUseCaseError("BUDGET_ERROR"))
    }
    return Err(new RunUseCaseError("WALLET_EMPTY"))
  }

  // 3. Persist the wallet reservation id returned by the DO
  if (doResult.val.walletReservationId) {
    const reservationResult = await deps.services.budgetRuns.updateRunReservation({
      projectId: input.projectId,
      runId: run.id,
      walletReservationId: doResult.val.walletReservationId,
    })
    if (reservationResult.err) {
      return Err(new RunUseCaseError("BUDGET_ERROR"))
    }
  }

  return Ok({
    runId: run.id,
    status: doResult.val.summary.status,
    customerId: run.customerId,
    budgetAmount: doResult.val.summary.budgetAmount,
    consumedAmount: doResult.val.summary.consumedAmount,
    remainingAmount: doResult.val.summary.remainingAmount,
    currency: run.currency,
    workloadType: run.workloadType ?? null,
    workloadId: run.workloadId ?? null,
    traceId: run.traceId ?? null,
    parentRunId: run.parentRunId ?? null,
  })
}
