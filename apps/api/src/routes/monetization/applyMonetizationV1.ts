import { createRoute, z } from "@hono/zod-openapi"
import { APP_DOMAIN } from "@unprice/config"
import { type ApiKeyExtended, monetizationConfigSchema } from "@unprice/db/validators"
import {
  type MonetizationPlanOutcome,
  applyMonetizationConfig,
  type applyMonetizationConfigFailureStateSchema,
  applyMonetizationConfigOutputSchema,
} from "@unprice/services/use-cases"
import type { Context } from "hono"
import { endTime, startTime } from "hono/timing"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import type { ZodError, ZodIssue } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import type { HonoEnv } from "~/hono/env"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["monetization"]

/**
 * The project is never in the body — it comes from the bearer token. An unknown
 * top-level key is dropped rather than honoured, which is what makes a
 * `projectId` smuggled into the body inert instead of authoritative.
 */
const applyMonetizationRequestSchema = z.object({
  config: monetizationConfigSchema,
})

const applyOkSchema = applyMonetizationConfigOutputSchema.options[0]

const applyMonetizationResponseSchema = applyOkSchema.omit({ state: true }).extend({
  reviewUrl: z
    .string()
    .url()
    .nullable()
    .describe(
      "Dashboard link to the first draft this apply created, for a human to review and publish. Null when every plan was already unchanged or published"
    ),
})

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/monetization/apply",
      operationId: "monetization.apply",
      summary: "apply monetization configuration",
      description:
        "Turn one configuration document into draft plan versions for this project. Nothing is published: a human reviews and publishes the drafts from the dashboard.",
      method: "post",
      tags,
      request: {
        body: jsonContentRequired(
          applyMonetizationRequestSchema,
          "The desired monetization configuration for the project the key belongs to"
        ),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          applyMonetizationResponseSchema,
          "Per-plan outcomes, drafts left behind by earlier documents, and what the application has to call at runtime"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "configuration",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["monetization", "apply"],
      },
    }
  )
)

export type ApplyMonetizationRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type ApplyMonetizationResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

type ApplyOutput = z.infer<typeof applyMonetizationConfigOutputSchema>
type ApplyFailure = Exclude<ApplyOutput, { state: "ok" }>
type WriteFailureState = z.infer<typeof applyMonetizationConfigFailureStateSchema>

/**
 * A document is a tree, so "it is wrong" is not actionable. `issuePath` renders
 * a Zod path the way an agent would address the value it sent: dots for keys,
 * brackets for array indices.
 */
function issuePath(issue: ZodIssue): string {
  return issue.path.reduce<string>((path, segment) => {
    if (typeof segment === "number") {
      return `${path}[${segment}]`
    }

    return path === "" ? String(segment) : `${path}.${String(segment)}`
  }, "")
}

function invalidConfigError(error: ZodError): UnpriceApiError {
  return new UnpriceApiError({
    code: "BAD_REQUEST",
    message: "The monetization configuration document is not valid",
    details: {
      kind: "invalid_config",
      issues: error.issues.map((issue) => ({
        path: issuePath(issue),
        message: issue.message,
      })),
    },
  })
}

/**
 * The write failures come from the plan and plan-version writers. `*_not_found`
 * means a row the writer owns went missing mid-run, which is ours and not the
 * caller's; the rest describe something the document asked for that this
 * project cannot accept.
 */
const WRITE_FAILURE_CODES = {
  plan_not_found: "INTERNAL_SERVER_ERROR",
  plan_version_not_found: "INTERNAL_SERVER_ERROR",
  plan_version_feature_not_found: "INTERNAL_SERVER_ERROR",
  feature_not_found: "INTERNAL_SERVER_ERROR",
  plan_version_published: "CONFLICT",
  default_enterprise_conflict: "CONFLICT",
  usage_meter_config_required: "BAD_REQUEST",
  invalid_reset_config: "BAD_REQUEST",
} as const satisfies Record<WriteFailureState, string>

function applyFailureToApiError(failure: ApplyFailure): UnpriceApiError {
  if (failure.state === "slug_conflict") {
    return new UnpriceApiError({
      code: "CONFLICT",
      message: failure.message,
      details: { kind: "slug_conflict" },
    })
  }

  if (failure.state === "unresolved_reference") {
    return new UnpriceApiError({
      code: "BAD_REQUEST",
      message: failure.message,
      details: { kind: "unresolved_reference" },
    })
  }

  // The state alone is not actionable across a document with many plans and
  // features, so whichever locator the writer knew about is named. Never the
  // document, never a database message.
  const locator = [
    failure.planSlug ? `plan "${failure.planSlug}"` : null,
    failure.featureSlug ? `feature "${failure.featureSlug}"` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ")

  return new UnpriceApiError({
    code: WRITE_FAILURE_CODES[failure.state],
    message: locator ? `${failure.state} (${locator})` : failure.state,
  })
}

/**
 * The dashboard page a human opens to review what this apply wrote. Both slugs
 * come off the verified key, so the link costs no extra read.
 *
 * The `string | undefined` on the workspace slug is deliberate and is not
 * redundant with its declared type. A verified key can come from a cache entry
 * serialized before `workspace.slug` was selected: those entries are plain JSON
 * and are never re-parsed on read (see `ApiKeyCache`), and they stay servable
 * for the full 24h stale window after a deploy. Trusting the compiler's
 * `string` there would emit `/undefined/acme-api/plans/...` — a link that looks
 * real and resolves to nothing — for a day after release.
 *
 * A link is a courtesy, not the result: when it cannot be built the outcomes
 * still come back and `reviewUrl` is null.
 */
function resolveReviewUrl(
  c: Context<HonoEnv>,
  key: ApiKeyExtended,
  plans: MonetizationPlanOutcome[]
): string | null {
  const created = plans.find((plan) => plan.status === "created")

  if (!created) {
    return null
  }

  const workspaceSlug: string | undefined = key.project.workspace.slug

  if (!workspaceSlug) {
    c.get("logger").warn("monetization.apply could not resolve a review url", {
      projectId: key.projectId,
      workspaceId: key.project.workspaceId,
      planVersionId: created.planVersionId,
    })

    return null
  }

  const path = [workspaceSlug, key.project.slug, "plans", created.slug, created.planVersionId]
    .map((segment) => encodeURIComponent(segment))
    .join("/")

  return new URL(`/${path}`, APP_DOMAIN).toString()
}

export const registerApplyMonetizationV1 = (app: App) =>
  app.openapi(
    route,
    async (c) => {
      const { config } = c.req.valid("json")

      const key = await keyAuth(c, { requireType: "config" })

      startTime(c, "applyMonetizationConfig")

      const { err, val } = await applyMonetizationConfig(
        {
          services: c.get("services"),
          db: c.get("db"),
          logger: c.get("logger"),
        },
        {
          // never the document, never the body
          projectId: key.projectId,
          config,
        }
      )

      endTime(c, "applyMonetizationConfig")

      if (err) {
        throw toUnpriceApiError(err)
      }

      if (val.state !== "ok") {
        throw applyFailureToApiError(val)
      }

      return c.json(
        {
          plans: val.plans,
          staleDrafts: val.staleDrafts,
          integrationContract: val.integrationContract,
          reviewUrl: resolveReviewUrl(c, key, val.plans),
        },
        HttpStatusCodes.OK
      )
    },
    // The shared `handleZodError` hook flattens a ZodError into one sentence.
    // A configuration document needs its paths kept, so this route replaces it.
    (result) => {
      if (!result.success) {
        throw invalidConfigError(result.error)
      }

      return undefined
    }
  )
