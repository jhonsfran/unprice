import { BaseError, type Result } from "@unprice/error"

export type RunBudgetSummary = {
  runId: string
  status: "running" | "completed" | "expired" | "canceled" | "budget_exceeded" | "failed"
  budgetAmount: number
  consumedAmount: number
  remainingAmount: number
}

export type RunBudgetStartResult = {
  summary: RunBudgetSummary
  walletReservationId: string
  walletError?: string
}

export type RunSyncDecision = {
  allowed: boolean
  state: "processed" | "rejected"
  rejectionReason?:
    | "LIMIT_EXCEEDED"
    | "WALLET_EMPTY"
    | "LATE_EVENT_CLOSED_PERIOD"
    | "RUN_BUDGET_EXCEEDED"
  message?: string
  budget: RunBudgetSummary
}

export class RunBudgetError extends BaseError {
  public readonly retry = false
  public readonly name = "RunBudgetError"
}

export interface RunBudgetClient {
  startRun(input: {
    projectId: string
    customerId: string
    runId: string
    budgetAmount: number
    currency: string
    idempotencyKey: string
    agentId?: string | null
    traceId?: string | null
    metadata?: Record<string, unknown>
    expiresAt?: number | null
  }): Promise<Result<RunBudgetStartResult, RunBudgetError>>

  applySyncEvent(input: {
    projectId: string
    customerId: string
    runId: string
    featureSlug: string
    idempotencyKey: string
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
  }): Promise<Result<RunSyncDecision, RunBudgetError>>

  endRun(input: {
    projectId: string
    customerId: string
    runId: string
    status: "completed" | "expired" | "canceled"
    endedAt: number
  }): Promise<Result<RunBudgetSummary, RunBudgetError>>

  getRunStatus(input: {
    projectId: string
    customerId: string
    runId: string
  }): Promise<Result<RunBudgetSummary, RunBudgetError>>
}
