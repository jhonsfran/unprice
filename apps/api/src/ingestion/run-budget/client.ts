import { Err, Ok, type Result } from "@unprice/error"
import {
  type IngestionEntitlement,
  type IngestionGrant,
  buildRunBudgetName,
} from "@unprice/services/ingestion"
import type {
  RunBudgetClient,
  RunBudgetError,
  RunBudgetStartResult,
  RunBudgetSummary,
  RunSyncDecision,
} from "@unprice/services/use-cases"
import { RunBudgetError as RunBudgetErrorClass } from "@unprice/services/use-cases"
import type { Env } from "~/env"
import type { RunBudgetDecision } from "./contracts"

type RunWorkloadType = "agent" | "workflow" | "job" | "tool" | "custom"

export class CloudflareRunBudgetClient implements RunBudgetClient {
  private readonly appEnv: Env["APP_ENV"]
  private readonly runbudget: Env["runbudget"]

  constructor(env: Pick<Env, "APP_ENV" | "runbudget">) {
    this.appEnv = env.APP_ENV
    this.runbudget = env.runbudget
  }

  async startRun(input: {
    projectId: string
    customerId: string
    runId: string
    budgetAmount: number
    currency: string
    idempotencyKey: string
    workloadType?: RunWorkloadType | null
    workloadId?: string | null
    traceId?: string | null
    parentRunId?: string | null
    metadata?: Record<string, unknown>
    expiresAt?: number | null
  }): Promise<Result<RunBudgetStartResult, RunBudgetError>> {
    try {
      const summary = await this.stub(input).startRun({
        ...input,
        metadata: input.metadata ?? {},
        now: Date.now(),
      })
      return Ok({
        summary,
        walletReservationId: summary.walletReservationId ?? "",
        walletError: summary.walletError,
      })
    } catch (error) {
      return Err(
        new RunBudgetErrorClass({
          message: error instanceof Error ? error.message : "startRun failed",
        })
      )
    }
  }

  async applySyncEvent(input: {
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
    customerEntitlementId: string
    entitlement: IngestionEntitlement & {
      meterConfig: NonNullable<IngestionEntitlement["meterConfig"]>
    }
    grants: IngestionGrant[]
  }): Promise<Result<RunSyncDecision, RunBudgetError>> {
    try {
      const decision: RunBudgetDecision = await this.stub(input).applySyncEvent(input)
      return Ok({
        allowed: decision.allowed,
        state: decision.state,
        rejectionReason: decision.rejectionReason,
        message: decision.message,
        budget: decision.budget,
      })
    } catch (error) {
      return Err(
        new RunBudgetErrorClass({
          message: error instanceof Error ? error.message : "applySyncEvent failed",
        })
      )
    }
  }

  async endRun(input: {
    projectId: string
    customerId: string
    runId: string
    status: "completed" | "expired" | "canceled"
    endedAt: number
  }): Promise<Result<RunBudgetSummary, RunBudgetError>> {
    try {
      const summary = await this.stub(input).endRun(input)
      return Ok(summary)
    } catch (error) {
      return Err(
        new RunBudgetErrorClass({
          message: error instanceof Error ? error.message : "endRun failed",
        })
      )
    }
  }

  async getRunStatus(input: {
    projectId: string
    customerId: string
    runId: string
  }): Promise<Result<RunBudgetSummary, RunBudgetError>> {
    try {
      const summary = await this.stub(input).getRunStatus(input)
      return Ok(summary)
    } catch (error) {
      return Err(
        new RunBudgetErrorClass({
          message: error instanceof Error ? error.message : "getRunStatus failed",
        })
      )
    }
  }

  private stub(input: { projectId: string; customerId: string; runId: string }) {
    return this.runbudget.getByName(
      buildRunBudgetName({
        appEnv: this.appEnv,
        customerId: input.customerId,
        projectId: input.projectId,
        runId: input.runId,
      })
    )
  }
}
