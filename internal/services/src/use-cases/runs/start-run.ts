import type { RunSummary } from "@unprice/db/validators"
import { BaseError, Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { BudgetRunService } from "../../budget-runs"
import type { RunBudgetClient } from "./run-budget-client"

export class RunUseCaseError extends BaseError {
  public readonly retry = false
  public readonly name = "RunUseCaseError"

  constructor(message: "RUN_NOT_FOUND" | "CUSTOMER_NOT_FOUND" | "BUDGET_ERROR") {
    super({ message })
  }
}

export type StartRunResolvedInput = {
  projectId: string
  customerId: string
  budgetAmount: number
  currency: string
  idempotencyKey: string
  agentId?: string | null
  traceId?: string | null
  metadata?: Record<string, unknown>
  expiresAt?: number | null
}

export type StartRunDeps = {
  services: Pick<{ budgetRuns: BudgetRunService }, "budgetRuns">
  runBudget: RunBudgetClient
  logger?: Logger
}

export async function startRun(
  deps: StartRunDeps,
  input: StartRunResolvedInput
): Promise<Result<RunSummary, RunUseCaseError>> {
  // 1. Create or fetch the Postgres budget_runs row by idempotency key
  const createResult = await deps.services.budgetRuns.createRun({
    projectId: input.projectId,
    customerId: input.customerId,
    budgetAmount: input.budgetAmount,
    remainingAmount: input.budgetAmount,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    agentId: input.agentId,
    traceId: input.traceId,
    metadata: input.metadata,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
  })

  if (createResult.err) {
    return Err(new RunUseCaseError("BUDGET_ERROR"))
  }

  const run = createResult.val

  // 2. Call RunBudgetDO with the canonical run id
  const doResult = await deps.runBudget.startRun({
    projectId: input.projectId,
    customerId: input.customerId,
    runId: run.id,
    budgetAmount: input.budgetAmount,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    agentId: input.agentId,
    traceId: input.traceId,
    metadata: input.metadata,
    expiresAt: input.expiresAt,
  })

  if (doResult.err) {
    return Err(new RunUseCaseError("BUDGET_ERROR"))
  }

  // 3. Persist the wallet reservation id returned by the DO
  if (doResult.val.walletReservationId) {
    await deps.services.budgetRuns.updateRunReservation({
      projectId: input.projectId,
      runId: run.id,
      walletReservationId: doResult.val.walletReservationId,
    })
  }

  return Ok({
    runId: run.id,
    status: doResult.val.summary.status,
    customerId: run.customerId,
    budgetAmount: doResult.val.summary.budgetAmount,
    consumedAmount: doResult.val.summary.consumedAmount,
    remainingAmount: doResult.val.summary.remainingAmount,
    currency: run.currency,
    agentId: run.agentId,
  })
}
