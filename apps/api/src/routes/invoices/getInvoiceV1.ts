import { createRoute } from "@hono/zod-openapi"
import { invoices } from "@unprice/db/schema"
import {
  currencySchema,
  invoiceSettlementSourceSchema,
  invoiceSettlementStatusSchema,
  invoiceStatusSchema,
  walletCreditSourceSchema,
} from "@unprice/db/validators"
import { toLedgerMinor } from "@unprice/money"
import { and, eq } from "drizzle-orm"
import { jsonContent } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["invoices"]

const invoiceHeaderSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  subscription_id: z.string(),
  customer_id: z.string(),
  status: invoiceStatusSchema,
  currency: currencySchema,
  statement_key: z.string(),
  statement_start_at: z.number().int(),
  statement_end_at: z.number().int(),
  due_at: z.number().int(),
  past_due_at: z.number().int(),
  issue_date: z.number().int().nullable(),
  sent_at: z.number().int().nullable(),
  paid_at: z.number().int().nullable(),
  gross_amount: z.number().int().nonnegative(),
  amount_due: z.number().int().nonnegative(),
  amount_paid: z.number().int().nonnegative(),
  amount_included: z.number().int().nonnegative(),
})

const invoiceLineSchema = z.object({
  entry_id: z.string(),
  statement_key: z.string(),
  kind: z.string(),
  description: z.string().nullable(),
  quantity: z.number().nullable(),
  amount: z.number().int().nonnegative(),
  amount_due: z.number().int().nonnegative(),
  amount_paid: z.number().int().nonnegative(),
  amount_included: z.number().int().nonnegative(),
  collectable: z.boolean(),
  settlement_source: invoiceSettlementSourceSchema,
  settlement_status: invoiceSettlementStatusSchema,
  wallet_credit_id: z.string().nullable(),
  wallet_credit_source: walletCreditSourceSchema.nullable(),
  wallet_id: z.string().nullable(),
  currency: currencySchema,
  created_at: z.string().datetime(),
})

const invoiceResponseSchema = z.object({
  invoice: invoiceHeaderSchema,
  lines: invoiceLineSchema.array(),
})

export const route = createRoute({
  path: "/v1/invoices/{invoiceId}",
  operationId: "invoices.get",
  summary: "get invoice",
  description:
    "Fetch an invoice header along with its line items projected from the ledger. Amounts are at pgledger scale 8 ($1 = 100_000_000). Provider calls convert to currency minor units at the provider boundary.",
  method: "get",
  tags,
  request: {
    params: z.object({
      invoiceId: z.string().openapi({
        description: "The invoice ID",
        example: "inv_1H7KQFLr7RepUyQBKdnvY",
      }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(invoiceResponseSchema, "Invoice header + projection lines"),
    ...openApiErrorResponses,
  },
})

export type GetInvoiceResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetInvoiceV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { invoiceId } = c.req.valid("param")
    const { ledger } = c.get("services")
    const db = c.get("db")

    const key = await keyAuth(c)

    const isMain = key.project.isMain ?? false

    const row = await db.query.invoices.findFirst({
      where: isMain
        ? eq(invoices.id, invoiceId)
        : and(eq(invoices.id, invoiceId), eq(invoices.projectId, key.projectId)),
    })

    if (!row) {
      throw new UnpriceApiError({ code: "NOT_FOUND", message: "Invoice not found" })
    }

    const { val: lines, err } = await ledger.getInvoiceLines({
      projectId: row.projectId,
      statementKey: row.statementKey,
    })

    if (err) {
      throw toUnpriceApiError(err)
    }

    return c.json(
      {
        invoice: {
          id: row.id,
          project_id: row.projectId,
          subscription_id: row.subscriptionId,
          customer_id: row.customerId,
          status: row.status,
          currency: row.currency,
          statement_key: row.statementKey,
          statement_start_at: row.statementStartAt,
          statement_end_at: row.statementEndAt,
          due_at: row.dueAt,
          past_due_at: row.pastDueAt,
          issue_date: row.issueDate ?? null,
          sent_at: row.sentAt ?? null,
          paid_at: row.paidAt ?? null,
          gross_amount: row.grossAmount,
          amount_due: row.amountDue,
          amount_paid: row.amountPaid,
          amount_included: row.amountIncluded,
        },
        lines: lines.map((line) => ({
          entry_id: line.entryId,
          statement_key: line.statementKey,
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          amount: toLedgerMinor(line.amount),
          amount_due: line.amountDue,
          amount_paid: line.amountPaid,
          amount_included: line.amountIncluded,
          collectable: line.collectable,
          settlement_source: line.settlementSource,
          settlement_status: line.settlementStatus,
          wallet_credit_id: line.walletCreditId,
          wallet_credit_source: line.walletCreditSource,
          wallet_id: line.walletId,
          currency: line.currency,
          created_at: line.createdAt.toISOString(),
        })),
      },
      HttpStatusCodes.OK
    )
  })
