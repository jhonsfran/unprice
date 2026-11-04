import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { Ok } from "@unprice/error"
import { statementPeriodId } from "../use-cases/budgets/compile-payer-budget"
import type { PayerStatementLine } from "../use-cases/budgets/invoice-payer-statements"
import type { PayerBudgetGateway } from "../use-cases/budgets/payer-budget-gateway"

/** What the payer budget accepted for a feature in each of its periods, at the ledger scale. */
type AcceptedUsage = Readonly<Record<string, { amount: number; quantity: number }>>

const SCALE = 100_000_000

/**
 * A payer budget that priced `acceptedUsage` per metered feature in every period it seals, so a
 * billing test states the usage its invoice bills independently of wallet captures. A sealed
 * statement keeps what it answered on a retry; completions are recorded.
 */
export function createRecordedUsageFixture(db: Database, acceptedUsage: AcceptedUsage) {
  // Billing never sends analytics; web events go through their own writer, not this client.
  const analytics = {} as Analytics
  const sealed = new Map<string, PayerStatementLine>()
  const completed: string[] = []
  const payerBudgets: PayerBudgetGateway = {
    sync: async (input) =>
      Ok({
        status: "synced",
        key: `unprice:customer:${input.customerId}`,
        version: 1,
        changes: [],
        statements: 0,
      }),
    seal: async (input) => {
      const periods = await db.query.billingPeriods.findMany({
        where: (table, { and, eq }) =>
          and(
            eq(table.projectId, input.projectId),
            eq(table.customerId, input.customerId),
            eq(table.statementKey, input.statementKey)
          ),
        with: { subscriptionItem: { with: { featurePlanVersion: { with: { feature: true } } } } },
      })
      for (const period of periods) {
        if (period.subscriptionItem.featurePlanVersion.featureType !== "usage") continue
        if (period.cycleEndAt > input.at || sealed.has(period.id)) continue
        const featureSlug = period.subscriptionItem.featurePlanVersion.feature.slug
        const accepted = acceptedUsage[featureSlug] ?? { amount: 0, quantity: 0 }
        sealed.set(period.id, {
          periodId: statementPeriodId(featureSlug, period.id),
          billingPeriodId: period.id,
          statementKey: period.statementKey,
          featureSlug,
          start: period.cycleStartAt,
          end: period.cycleEndAt,
          amount: String(accepted.amount),
          quantity: String(Math.round(accepted.quantity * SCALE)),
          cost: null,
          events: accepted.quantity > 0 ? 1 : 0,
        })
      }
      const lines = [...sealed.values()].filter((line) => line.statementKey === input.statementKey)
      return Ok({ sealed: lines, open: [] })
    },
    completeInvoiced: async () => {
      const periods = await db.query.billingPeriods.findMany({
        columns: { id: true },
        where: (table, { inArray }) => inArray(table.status, ["invoiced", "voided"]),
      })
      const done = periods
        .map((period) => sealed.get(period.id)?.periodId)
        .filter((id): id is string => id !== undefined && !completed.includes(id))
      completed.push(...done)
      return Ok({ completed: done })
    },
  }
  return { analytics, payerBudgets, completed }
}
