import { BaseError, Err, Ok, type Result } from "@unprice/error"
import { buildRunBudgetName } from "@unprice/services/ingestion"
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

export class CloudflareRunBudgetClient implements RunBudgetClient {
  private readonly appEnv: Env["APP_ENV"]
  private readonly runbudget: Env["runbudget"]

  constructor(env: Pick<Env, "APP_ENV" | "runbudget">) {
    this.appEnv = env.APP_ENV
    this.runbudget = env.runbudget
  }

  async startRun(
    input: Parameters<RunBudgetClient["startRun"]>[0]
  ): Promise<Result<RunBudgetStartResult, RunBudgetError>> {
    try {
      const summary = await this.stub(input).startRun({
        ...input,
        metadata: input.metadata ?? {},
        now: Date.now(),
      })
      return Ok({
        summary,
        walletReservationId: summary.walletReservationId ?? null,
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

  async applySyncEvent(
    input: Parameters<RunBudgetClient["applySyncEvent"]>[0]
  ): Promise<Result<RunSyncDecision, RunBudgetError>> {
    try {
      const decision: RunBudgetDecision = await this.stub(input).applySyncEvent(input)
      return Ok({
        allowed: decision.allowed,
        state: decision.state,
        rejectionReason: decision.rejectionReason,
        message: decision.message,
        budget: decision.budget,
        meterFacts: decision.meterFacts ?? [],
      })
    } catch (error) {
      return Err(
        new RunBudgetErrorClass({
          message: error instanceof Error ? error.message : "applySyncEvent failed",
        })
      )
    }
  }

  async endRun(
    input: Parameters<RunBudgetClient["endRun"]>[0]
  ): Promise<Result<RunBudgetSummary, RunBudgetError>> {
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

  async getRunStatus(
    input: Parameters<RunBudgetClient["getRunStatus"]>[0]
  ): Promise<Result<RunBudgetSummary, RunBudgetError>> {
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

  async flushCapturesForInvoicing(
    input: Parameters<RunBudgetClient["flushCapturesForInvoicing"]>[0]
  ): Promise<Result<{ flushed: number; skipped: number }, RunBudgetError>> {
    const stub = this.stub(input)

    try {
      const result = await stub.flushCapturesForInvoicing({
        statementKey: input.statementKey,
        billingPeriodIds: input.billingPeriodIds,
      })
      return Ok({ flushed: result.flushed, skipped: result.skipped })
    } catch (error) {
      return Err(
        new RunBudgetErrorClass({
          message: error instanceof Error ? error.message : "flushCapturesForInvoicing failed",
          ...(error instanceof BaseError ? { cause: error } : {}),
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
