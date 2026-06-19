import { type Database, and, eq } from "@unprice/db"
import { budgetRuns } from "@unprice/db/schema"
import type { BudgetRunStatus } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import { BaseError, Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"

export class BudgetRunServiceError extends BaseError {
  public readonly retry = false
  public readonly name = "BudgetRunServiceError"
}

type BudgetRunServiceDeps = {
  db: Database
  logger: Logger
}

type BudgetRunRow = typeof budgetRuns.$inferSelect

export class BudgetRunService {
  constructor(private readonly deps: BudgetRunServiceDeps) {}

  async createRun(input: {
    projectId: string
    customerId: string
    budgetAmount: number
    remainingAmount: number
    currency: string
    idempotencyKey: string
    agentId?: string | null
    traceId?: string | null
    metadata?: Record<string, unknown>
    expiresAt?: Date | null
  }): Promise<Result<BudgetRunRow, BudgetRunServiceError>> {
    try {
      const id = newId("budget_run")
      const [row] = await this.deps.db
        .insert(budgetRuns)
        .values({
          id,
          projectId: input.projectId,
          customerId: input.customerId,
          status: "running",
          budgetAmount: input.budgetAmount,
          consumedAmount: 0,
          remainingAmount: input.remainingAmount,
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
          agentId: input.agentId ?? null,
          traceId: input.traceId ?? null,
          metadata: input.metadata ?? {},
          expiresAt: input.expiresAt ?? null,
        })
        .onConflictDoNothing({
          target: [budgetRuns.projectId, budgetRuns.customerId, budgetRuns.idempotencyKey],
        })
        .returning()

      // If conflict, fetch existing row
      if (!row) {
        return this.getRunByIdempotencyKey({
          projectId: input.projectId,
          customerId: input.customerId,
          idempotencyKey: input.idempotencyKey,
        })
      }

      return Ok(row)
    } catch (_error) {
      return Err(
        new BudgetRunServiceError({
          message: "Failed to create budget run",
        })
      )
    }
  }

  async getRun(input: {
    projectId: string
    runId: string
  }): Promise<Result<BudgetRunRow, BudgetRunServiceError>> {
    try {
      const row = await this.deps.db.query.budgetRuns.findFirst({
        where: and(eq(budgetRuns.id, input.runId), eq(budgetRuns.projectId, input.projectId)),
      })

      if (!row) {
        return Err(
          new BudgetRunServiceError({
            message: "RUN_NOT_FOUND",
          })
        )
      }

      return Ok(row)
    } catch (_error) {
      return Err(
        new BudgetRunServiceError({
          message: "Failed to get budget run",
        })
      )
    }
  }

  async updateRunReservation(input: {
    projectId: string
    runId: string
    walletReservationId: string
  }): Promise<Result<BudgetRunRow, BudgetRunServiceError>> {
    try {
      const [row] = await this.deps.db
        .update(budgetRuns)
        .set({
          walletReservationId: input.walletReservationId,
          updatedAt: new Date(),
        })
        .where(and(eq(budgetRuns.id, input.runId), eq(budgetRuns.projectId, input.projectId)))
        .returning()

      if (!row) {
        return Err(new BudgetRunServiceError({ message: "RUN_NOT_FOUND" }))
      }

      return Ok(row)
    } catch (_error) {
      return Err(
        new BudgetRunServiceError({
          message: "Failed to update run reservation",
        })
      )
    }
  }

  async updateRunSummary(input: {
    projectId: string
    runId: string
    status: BudgetRunStatus
    statusReason?: string | null
    consumedAmount: number
    remainingAmount: number
    endedAt?: Date | null
  }): Promise<Result<BudgetRunRow, BudgetRunServiceError>> {
    try {
      const [row] = await this.deps.db
        .update(budgetRuns)
        .set({
          status: input.status,
          statusReason: input.statusReason ?? null,
          consumedAmount: input.consumedAmount,
          remainingAmount: input.remainingAmount,
          endedAt: input.endedAt ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(budgetRuns.id, input.runId), eq(budgetRuns.projectId, input.projectId)))
        .returning()

      if (!row) {
        return Err(new BudgetRunServiceError({ message: "RUN_NOT_FOUND" }))
      }

      return Ok(row)
    } catch (_error) {
      return Err(
        new BudgetRunServiceError({
          message: "Failed to update run summary",
        })
      )
    }
  }

  private async getRunByIdempotencyKey(input: {
    projectId: string
    customerId: string
    idempotencyKey: string
  }): Promise<Result<BudgetRunRow, BudgetRunServiceError>> {
    try {
      const row = await this.deps.db.query.budgetRuns.findFirst({
        where: and(
          eq(budgetRuns.projectId, input.projectId),
          eq(budgetRuns.customerId, input.customerId),
          eq(budgetRuns.idempotencyKey, input.idempotencyKey)
        ),
      })

      if (!row) {
        return Err(new BudgetRunServiceError({ message: "RUN_NOT_FOUND" }))
      }

      return Ok(row)
    } catch (_error) {
      return Err(
        new BudgetRunServiceError({
          message: "Failed to get budget run by idempotency key",
        })
      )
    }
  }
}
