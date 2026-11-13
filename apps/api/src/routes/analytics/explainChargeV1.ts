import { createRoute } from "@hono/zod-openapi"
import {
  ExplainChargeError,
  aiAnswerEnvelopeSchema,
  aiEvidenceSchema,
  explainCharge,
  explainChargeEventSchema,
} from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import {
  keyAuth,
  resolveCustomerIdForApiKeyOrThrow,
  validateIsAllowedToAccessProject,
} from "~/auth/key"
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["analytics"]

export const explainChargeApiResponseSchema = z.object({
  invoice: z.object({
    id: z.string(),
    statement_key: z.string(),
    customer_id: z.string(),
    currency: z.string(),
  }),
  line: z.object({
    entry_id: z.string(),
    billing_period_id: z.string(),
    kind: z.string(),
    amount: z.number().int(),
    currency: z.string(),
  }),
  scope: z.object({
    project_id: z.string(),
    customer_id: z.string(),
    feature_slug: z.string(),
    period_key: z.string(),
    customer_entitlement_id: z.string().nullable(),
    feature_plan_version_id: z.string().nullable(),
  }),
  summary: z.object({
    event_count: z.number().int(),
    total_usage: z.number(),
    total_amount: z.number().int(),
    currency: z.string(),
    amount_scale: z.number().int(),
    first_event_at: z.number().int().nullable(),
    last_event_at: z.number().int().nullable(),
    multi_component_event_count: z.number().int(),
  }),
  pricing: z.object({
    feature_type: z.string(),
    usage_mode: z.string().nullable(),
    unit_of_measure: z.string(),
    description: z.string(),
    rows: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
      })
    ),
  }),
  events: z.array(explainChargeEventSchema),
  answer: z.string(),
  confidence: aiAnswerEnvelopeSchema.shape.confidence,
  freshness: aiAnswerEnvelopeSchema.shape.freshness,
  evidence: z.array(aiEvidenceSchema),
  warnings: aiAnswerEnvelopeSchema.shape.warnings,
  nextActions: aiAnswerEnvelopeSchema.shape.nextActions,
  pagination: z.object({
    limit: z.number().int(),
    offset: z.number().int(),
    has_more: z.boolean(),
  }),
})

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/analytics/charges/explain",
      operationId: "analytics.charges.explain",
      summary: "explain charge",
      description: "Explain one invoice line using ledger metadata and journal events.",
      method: "post",
      tags,
      request: {
        body: jsonContentRequired(
          z.object({
            project_id: z.string().optional(),
            invoice_id: z.string(),
            entry_id: z.string(),
            limit: z.number().int().min(1).max(500).optional().default(100),
            offset: z.number().int().min(0).optional().default(0),
          }),
          "Explain charge request"
        ),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          explainChargeApiResponseSchema,
          "Explain charge response"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "analytics",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["analytics", "charges", "explain"],
      },
    }
  )
)

export type ExplainChargeApiRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type ExplainChargeApiResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerExplainChargeV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const {
      project_id: requestedProjectId,
      invoice_id: invoiceId,
      entry_id: entryId,
      limit,
      offset,
    } = c.req.valid("json")
    const key = await keyAuth(c)
    const { ledger } = c.get("services")
    const projectId = validateIsAllowedToAccessProject({
      key,
      requestedProjectId: requestedProjectId ?? key.projectId,
    })

    const result = await explainCharge(
      {
        db: c.get("db"),
        ledger,
        budgetJournal: c.get("services").budgetJournal,
        rateCards: c.get("services").rateCards,
      },
      {
        projectId,
        invoiceId,
        entryId,
        limit,
        offset,
      }
    )

    if (result.err) {
      throw explainChargeErrorToApiError(result.err)
    }

    resolveCustomerIdForApiKeyOrThrow({
      explicitCustomerId: result.val.invoice.customerId,
      defaultCustomerId: key.defaultCustomerId,
    })

    const response: ExplainChargeApiResponse = {
      invoice: {
        id: result.val.invoice.id,
        statement_key: result.val.invoice.statementKey,
        customer_id: result.val.invoice.customerId,
        currency: result.val.invoice.currency,
      },
      line: {
        entry_id: result.val.line.entryId,
        billing_period_id: result.val.line.billingPeriodId,
        kind: result.val.line.kind,
        amount: result.val.line.amount,
        currency: result.val.line.currency,
      },
      scope: {
        project_id: result.val.scope.projectId,
        customer_id: result.val.scope.customerId,
        feature_slug: result.val.scope.featureSlug,
        period_key: result.val.scope.periodKey,
        customer_entitlement_id: result.val.scope.customerEntitlementId,
        feature_plan_version_id: result.val.scope.featurePlanVersionId,
      },
      summary: {
        event_count: result.val.summary.eventCount,
        total_usage: result.val.summary.totalUsage,
        total_amount: result.val.summary.totalAmount,
        currency: result.val.summary.currency,
        amount_scale: result.val.summary.amountScale,
        first_event_at: result.val.summary.firstEventAt,
        last_event_at: result.val.summary.lastEventAt,
        multi_component_event_count: result.val.summary.multiComponentEventCount,
      },
      pricing: {
        feature_type: result.val.pricing.featureType,
        usage_mode: result.val.pricing.usageMode,
        unit_of_measure: result.val.pricing.unitOfMeasure,
        description: result.val.pricing.description,
        rows: result.val.pricing.rows,
      },
      events: result.val.events,
      answer: result.val.answer,
      confidence: result.val.confidence,
      freshness: result.val.freshness,
      evidence: result.val.evidence,
      warnings: result.val.warnings,
      nextActions: result.val.nextActions,
      pagination: {
        limit: result.val.pagination.limit,
        offset: result.val.pagination.offset,
        has_more: result.val.pagination.hasMore,
      },
    }

    return c.json(response, HttpStatusCodes.OK)
  })

function explainChargeErrorToApiError(error: unknown): UnpriceApiError {
  if (error instanceof ExplainChargeError) {
    switch (error.code) {
      case "INVOICE_NOT_FOUND":
      case "LEDGER_LINE_NOT_FOUND":
      case "BILLING_PERIOD_NOT_FOUND":
      case "FEATURE_NOT_FOUND":
        return new UnpriceApiError({ code: "NOT_FOUND", message: error.message })
      case "BILLING_PERIOD_CONTEXT_MISMATCH":
      case "BILLING_PERIOD_METADATA_MISSING":
        return new UnpriceApiError({ code: "BAD_REQUEST", message: error.message })
    }
  }

  return toUnpriceApiError(error)
}
