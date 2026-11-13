import type { Database } from "@unprice/db"
import { and, count, eq } from "@unprice/db"
import { invoices } from "@unprice/db/schema"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"

export const getCustomerEconomicSummaryInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string(),
})

export const getCustomerEconomicSummaryOutputSchema = z.object({
  customerId: z.string(),
  invoiceCounts: z.object({
    total: z.number().int().nonnegative(),
    paid: z.number().int().nonnegative(),
  }),
})

export type GetCustomerEconomicSummaryInput = z.infer<typeof getCustomerEconomicSummaryInputSchema>
export type GetCustomerEconomicSummaryOutput = z.infer<
  typeof getCustomerEconomicSummaryOutputSchema
>

export type GetCustomerEconomicSummaryDeps = {
  db: Database
  logger: Pick<Logger, "error">
}

type CountRow = { count: number } | undefined

export function buildCustomerEconomicSummary(input: {
  customerId: string
  totalInvoices: number
  paidInvoices: number
}): GetCustomerEconomicSummaryOutput {
  return getCustomerEconomicSummaryOutputSchema.parse({
    customerId: input.customerId,
    invoiceCounts: {
      total: input.totalInvoices,
      paid: input.paidInvoices,
    },
  })
}

export async function getCustomerEconomicSummary(
  deps: GetCustomerEconomicSummaryDeps,
  rawInput: GetCustomerEconomicSummaryInput
): Promise<Result<GetCustomerEconomicSummaryOutput | null, FetchError>> {
  const input = getCustomerEconomicSummaryInputSchema.parse(rawInput)

  const result = await wrapResult(
    (async () => {
      const customer = await deps.db.query.customers.findFirst({
        columns: {
          id: true,
        },
        where: (table, { and, eq }) =>
          and(eq(table.id, input.customerId), eq(table.projectId, input.projectId)),
      })

      if (!customer) {
        return null
      }

      const [totalInvoices, paidInvoices] = await Promise.all([
        deps.db
          .select({ count: count() })
          .from(invoices)
          .where(
            and(eq(invoices.customerId, input.customerId), eq(invoices.projectId, input.projectId))
          ),
        deps.db
          .select({ count: count() })
          .from(invoices)
          .where(
            and(
              eq(invoices.customerId, input.customerId),
              eq(invoices.projectId, input.projectId),
              eq(invoices.status, "paid")
            )
          ),
      ])

      return buildCustomerEconomicSummary({
        customerId: input.customerId,
        totalInvoices: getCount(totalInvoices[0]),
        paidInvoices: getCount(paidInvoices[0]),
      })
    })(),
    (error) =>
      new FetchError({
        message: `error getting customer economic summary: ${error.message}`,
        retry: false,
      })
  )

  if (result.err) {
    deps.logger.error(result.err, {
      context: "error getting customer economic summary",
      projectId: input.projectId,
      customerId: input.customerId,
    })
    return Err(result.err)
  }

  return Ok(result.val ?? null)
}

function getCount(row: CountRow): number {
  return row?.count ?? 0
}
