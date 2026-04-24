import { createRoute } from "@hono/zod-openapi"
import { invoices } from "@unprice/db/schema"
import { currencySchema, invoiceStatusSchema } from "@unprice/db/validators"
import { and, eq } from "drizzle-orm"
import { toLedgerMinor } from "@unprice/money"
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
  total_amount: z.number().int().nonnegative(),
})

const invoiceLineSchema = z.object({
  entry_id: z.string(),
  statement_key: z.string(),
  kind: z.string(),
  description: z.string().nullable(),
  quantity: z.number().nullable(),
  amount: z.number().int().nonnegative(),
  currency: currencySchema,
  created_at: z.string().datetime(),
})

const invoiceResponseSchema = z.object({
  invoice: invoiceHeaderSchema,
  lines: invoiceLineSchema.array(),
})

export const route = createRoute({
  path: "/v1/invoices/{invoiceId}",
  operationId: "invoices.getInvoice",
  summary: "get invoice",
  description:
    "Fetch an invoice header along with its line items projected from the ledger. A line is a transfer that credits the customer's consumed sub-account and carries both `statement_key` and `kind` in metadata. Amounts are at pgledger scale 8 ($1 = 100_000_000).",
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
          total_amount: row.totalAmount,
        },
        lines: lines.map((line) => ({
          entry_id: line.entryId,
          statement_key: line.statementKey,
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          amount: toLedgerMinor(line.amount),
          currency: line.currency,
          created_at: line.createdAt.toISOString(),
        })),
      },
      HttpStatusCodes.OK
    )
  })
