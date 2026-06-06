import { createRoute } from "@hono/zod-openapi"
import { explainChargeEventRowSchema } from "@unprice/analytics"
import {
  ExplainChargeError,
  type ExplainChargeOutput,
  aiAnswerEnvelopeSchema,
  aiEvidenceSchema,
  explainCharge,
} from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth, validateIsAllowedToAccessProject } from "~/auth/key"
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
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
    latest_amount_after: z.number().int(),
    currency: z.string(),
    amount_scale: z.number().int(),
    first_event_at: z.number().int().nullable(),
    last_event_at: z.number().int().nullable(),
    multi_component_event_count: z.number().int(),
  }),
  events: z.array(explainChargeEventRowSchema),
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

export const route = createRoute({
  path: "/v1/analytics/explain-charge",
  operationId: "analytics.explainCharge",
  summary: "explain charge",
  description: "Explain one invoice line using ledger metadata and rated meter facts.",
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
    [HttpStatusCodes.OK]: jsonContent(explainChargeApiResponseSchema, "Explain charge response"),
    ...openApiErrorResponses,
  },
})

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
      isMain: (key.project.isMain ?? false) || key.project.workspace.isMain,
      key,
      requestedProjectId: requestedProjectId ?? key.projectId,
    })

    const result = await explainCharge(
      {
        db: c.get("db"),
        ledger,
        analytics: c.get("analytics"),
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
        latest_amount_after: result.val.summary.latestAmountAfter,
        currency: result.val.summary.currency,
        amount_scale: result.val.summary.amountScale,
        first_event_at: result.val.summary.firstEventAt,
        last_event_at: result.val.summary.lastEventAt,
        multi_component_event_count: result.val.summary.multiComponentEventCount,
      },
      events: result.val.events,
      answer: result.val.answer,
      confidence: buildConfidence({
        eventCount: result.val.summary.eventCount,
        eventsReturned: result.val.events.length,
      }),
      freshness: {
        generatedAt: Date.now(),
        dataFrom: result.val.summary.firstEventAt,
        dataTo: result.val.summary.lastEventAt,
      },
      evidence: buildEvidence(result.val),
      warnings: buildWarnings(result.val),
      nextActions: buildNextActions(result.val),
      pagination: {
        limit: result.val.pagination.limit,
        offset: result.val.pagination.offset,
        has_more: result.val.pagination.hasMore,
      },
    }

    return c.json(response, HttpStatusCodes.OK)
  })

function buildConfidence({
  eventCount,
  eventsReturned,
}: {
  eventCount: number
  eventsReturned: number
}): ExplainChargeApiResponse["confidence"] {
  if (eventCount > 0 || eventsReturned > 0) {
    return "high"
  }

  return "medium"
}

function buildEvidence(result: ExplainChargeOutput): ExplainChargeApiResponse["evidence"] {
  return [
    {
      type: "invoice" as const,
      id: result.invoice.id,
      source: "postgres" as const,
      timestamp: null,
    },
    {
      type: "ledger_line" as const,
      id: result.line.entryId,
      source: "ledger" as const,
      timestamp: null,
    },
    {
      type: "billing_period" as const,
      id: result.line.billingPeriodId,
      source: "postgres" as const,
      timestamp: null,
    },
    ...(result.scope.featurePlanVersionId
      ? [
          {
            type: "plan_version" as const,
            id: result.scope.featurePlanVersionId,
            source: "postgres" as const,
            timestamp: null,
          },
        ]
      : []),
    ...result.events.map((event) => ({
      type: "meter_fact" as const,
      id: [
        result.scope.projectId,
        result.scope.customerId,
        event.customer_entitlement_id,
        event.grant_id,
        event.event_id,
      ].join(":"),
      source: "tinybird" as const,
      timestamp: event.timestamp,
    })),
  ]
}

function buildWarnings(result: ExplainChargeOutput): string[] {
  const warnings: string[] = []

  if (result.summary.eventCount === 0) {
    warnings.push("No rated meter facts were found for this invoice line.")
  }

  if (result.pagination.hasMore) {
    warnings.push("Additional rated meter facts are available on later pages.")
  }

  return warnings
}

function buildNextActions(result: ExplainChargeOutput): string[] {
  if (result.summary.eventCount === 0) {
    return ["Verify the billing period, feature slug, and period key for this invoice line."]
  }

  if (result.pagination.hasMore) {
    return ["Request the next page to inspect the remaining rated meter facts."]
  }

  return ["No immediate action required."]
}

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
      case "PERIOD_KEY_NOT_DERIVED":
        return new UnpriceApiError({ code: "BAD_REQUEST", message: error.message })
    }
  }

  return toUnpriceApiError(error)
}
