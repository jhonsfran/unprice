import type { Database } from "@unprice/db"
import { Err, Ok, type Result } from "@unprice/error"
import { z } from "zod"
import type { Statement, UnPriceBudgetError } from "../../budgets"
import { payerBudgetKey } from "../../budgets/payer-key"
import { type ExecuteBudgetCommandDeps, executeBudgetCommand } from "./execute-budget-command"

/** An integer at the ledger scale (8 places), as a string: JSON carries no bigint. */
const baseUnitsSchema = z.string().regex(/^-?\d+$/, "an integer in base units")

export const sealPayerStatementsInputSchema = z.object({
  projectId: z.string().min(1),
  customerId: z.string().min(1),
  statementKey: z.string().min(1),
  /** Statements of the key that ended by this instant seal; the budget never seals past its clock. */
  at: z.number().int().nonnegative(),
})

/** One billing period of a metered feature as the payer budget priced it at ingestion. */
export const payerStatementLineSchema = z.object({
  periodId: z.string(),
  statementKey: z.string(),
  featureSlug: z.string(),
  start: z.number().int(),
  end: z.number().int(),
  /** What the accepted usage cost, in the budget's unit at the ledger scale. */
  amount: baseUnitsSchema,
  /** The metered quantity at the ledger scale. */
  quantity: baseUnitsSchema,
  /** Provider cost in USD at the ledger scale; null when no priced line carried a cost. */
  cost: baseUnitsSchema.nullable(),
  events: z.number().int().nonnegative(),
})

export const sealPayerStatementsOutputSchema = z.object({
  /** The key's sealed statements, the ones this seal sealed and any sealed before it. */
  sealed: z.array(payerStatementLineSchema),
  /** Period ids of the key still open: their period has not ended by the seal's cutoff. */
  open: z.array(z.string()),
})

export const completePayerStatementsInputSchema = z.object({
  projectId: z.string().min(1),
  customerId: z.string().min(1),
})

export const completePayerStatementsOutputSchema = z.object({
  /** The statements this call completed. */
  completed: z.array(z.string()),
})

export type SealPayerStatementsInput = z.infer<typeof sealPayerStatementsInputSchema>
export type SealPayerStatementsOutput = z.infer<typeof sealPayerStatementsOutputSchema>
export type PayerStatementLine = z.infer<typeof payerStatementLineSchema>
export type CompletePayerStatementsInput = z.infer<typeof completePayerStatementsInputSchema>
export type CompletePayerStatementsOutput = z.infer<typeof completePayerStatementsOutputSchema>

export type InvoicePayerStatementsDeps = ExecuteBudgetCommandDeps & { db: Database }

function toLine(statement: Statement): PayerStatementLine {
  return {
    periodId: statement.periodId,
    statementKey: statement.statementKey,
    featureSlug: statement.featureSlug,
    start: statement.start,
    end: statement.end,
    amount: statement.amount.toString(),
    quantity: statement.quantity.toString(),
    cost: statement.cost === null ? null : statement.cost.toString(),
    events: statement.events,
  }
}

/**
 * Seals the payer budget's statements of `statementKey` that ended by `at` (ADR-0008 D4, D10) and
 * answers them with the ones still open. Sealing also closes the key's prepaid wallet funding. A
 * customer without a payer budget accepted no usage, so it answers nothing.
 */
export async function sealPayerStatements(
  deps: InvoicePayerStatementsDeps,
  input: SealPayerStatementsInput
): Promise<Result<SealPayerStatementsOutput, UnPriceBudgetError>> {
  const { projectId, customerId, statementKey, at } = input
  const key = payerBudgetKey(customerId)
  const sealed = await executeBudgetCommand(deps, {
    projectId,
    key,
    request: { type: "sealStatements", statementKey, at },
  })
  if (sealed.err?.rejection.code === "BUDGET_NOT_FOUND") return Ok({ sealed: [], open: [] })
  if (sealed.err) return Err(sealed.err)

  return Ok({ sealed: sealed.val.statements.map(toLine), open: [...sealed.val.openPeriodIds] })
}

/**
 * Completes every sealed statement whose billing period is invoiced or voided: its invoice
 * committed, so the budget may drop it. Idempotent, and bounded by what the budget still holds,
 * so billing calls it before and after each invoice to finish a completion that failed.
 */
export async function completeInvoicedPayerStatements(
  deps: InvoicePayerStatementsDeps,
  input: CompletePayerStatementsInput
): Promise<Result<CompletePayerStatementsOutput, UnPriceBudgetError>> {
  const { projectId, customerId } = input
  const key = payerBudgetKey(customerId)
  const listed = await executeBudgetCommand(deps, {
    projectId,
    key,
    request: { type: "statements" },
  })
  if (listed.err?.rejection.code === "BUDGET_NOT_FOUND") return Ok({ completed: [] })
  if (listed.err) return Err(listed.err)

  const sealed = new Map(
    listed.val.statements
      .filter((statement) => statement.state === "sealed")
      .map((statement) => [statement.periodId, statement.periodId])
  )
  if (sealed.size === 0) return Ok({ completed: [] })

  const closed = await deps.db.query.billingPeriods.findMany({
    columns: { id: true },
    where: (period, ops) =>
      ops.and(
        ops.eq(period.projectId, projectId),
        ops.eq(period.customerId, customerId),
        ops.inArray(period.id, [...sealed.keys()]),
        ops.inArray(period.status, ["invoiced", "voided"])
      ),
  })
  const periodIds = closed.flatMap((period) => sealed.get(period.id) ?? [])
  if (periodIds.length === 0) return Ok({ completed: [] })

  const completed = await executeBudgetCommand(deps, {
    projectId,
    key,
    request: { type: "completeStatements", periodIds },
  })
  if (completed.err) return Err(completed.err)
  return Ok({ completed: periodIds })
}
