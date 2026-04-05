import type { ApiKeyExtended } from "@unprice/db/validators"
import { SchemaError } from "@unprice/error"
import { UnPriceApiKeyError } from "@unprice/services/apikey"
import type { Context } from "hono"
import { endTime, startTime } from "hono/timing"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

// verify is sensitive to latency
const API_KEY_RATE_LIMIT_BYPASS_PATHS = new Set(["/v1/customer/verify"])

/**
 * keyAuth takes the bearer token from the request and verifies the key
 *
 * if the key doesnt exist, isn't valid or isn't a root key, an error is thrown, which gets handled
 * automatically by hono
 */
export async function keyAuth(c: Context<HonoEnv>) {
  const authHeader = c.req.header("authorization")?.trim()
  const authorization = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()

  if (!authorization) {
    throw new UnpriceApiError({ code: "UNAUTHORIZED", message: "key required" })
  }

  const { apikey } = c.get("services")
  const logger = c.get("logger")

  // start timer
  startTime(c, "verifyApiKey")

  const shouldAvoidRateLimit = c.env.APP_ENV === "development"
  const requestPath =
    c.req.path.endsWith("/") && c.req.path.length > 1 ? c.req.path.slice(0, -1) : c.req.path
  const shouldBypassRateLimitPath = API_KEY_RATE_LIMIT_BYPASS_PATHS.has(requestPath)

  const verifyRes = await apikey.verifyApiKey({ key: authorization })

  // end timer
  endTime(c, "verifyApiKey")

  const { val: key, err } = verifyRes

  if (err) {
    switch (true) {
      case err instanceof SchemaError:
        throw new UnpriceApiError({
          code: "BAD_REQUEST",
          message: err.message,
        })
      case err instanceof UnPriceApiKeyError:
        switch (err.code) {
          case "NOT_FOUND":
            throw new UnpriceApiError({
              code: "UNAUTHORIZED",
              message: "key not found",
            })
          case "REVOKED":
            throw new UnpriceApiError({
              code: "UNAUTHORIZED",
              message: "key revoked",
            })
          case "EXPIRED":
            throw new UnpriceApiError({
              code: "EXPIRED",
              message: "key expired",
            })
          case "PROJECT_DISABLED":
          case "WORKSPACE_DISABLED":
            throw new UnpriceApiError({
              code: "DISABLED",
              message: err.message,
            })
          case "RATE_LIMIT_EXCEEDED":
            throw new UnpriceApiError({
              code: "RATE_LIMITED",
              message: err.message,
            })
          default:
            throw new UnpriceApiError({
              code: "INTERNAL_SERVER_ERROR",
              message: err.message,
            })
        }
    }
    throw new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message: err.message,
    })
  }

  if (!key) {
    throw new UnpriceApiError({
      code: "UNAUTHORIZED",
      message: "key not found",
    })
  }

  // don't rate limit important workspaces
  const shouldSkipRateLimit = key.project.isInternal || key.project.isMain

  c.set("isMain", key.project.isMain ?? false)
  c.set("isInternal", key.project.isInternal ?? false)
  c.set("workspaceId", key.project.workspaceId)
  c.set("projectId", key.project.id)
  c.set("unPriceCustomerId", key.project.workspace.unPriceCustomerId)

  logger.set({
    business: {
      project_id: key.project.id,
      workspace_id: key.project.workspaceId,
      is_main: key.project.isMain ?? false,
      is_internal: key.project.isInternal ?? false,
      unprice_customer_id: key.project.workspace.unPriceCustomerId,
    },
  })

  // Evaluate rate-limit after key verification so we can tag metrics with real workspace context.
  // If limiter infra fails, auth should continue (fail-open) and we capture the error in observability.
  let isRateLimited = false
  if (!shouldAvoidRateLimit && !shouldSkipRateLimit && !shouldBypassRateLimitPath) {
    try {
      isRateLimited = await apikey.rateLimit({
        path: requestPath,
        key: authorization,
        workspaceId: key.project.workspaceId,
        source: "cloudflare",
        limiter: c.env.RL_FREE_6000_60s,
      })
    } catch (rateLimitError) {
      logger.error("apikey rate limit check failed", {
        path: requestPath,
        workspaceId: key.project.workspaceId,
        error:
          rateLimitError instanceof Error ? rateLimitError.message : String(rateLimitError ?? ""),
      })
    }
  }

  // skip for internal and main projects
  if (isRateLimited) {
    logger.set({
      request: {
        rate_limited: true,
      },
    })
    throw new UnpriceApiError({ code: "RATE_LIMITED", message: "apikey rate limit exceeded" })
  }

  return key
}

/**
 * Resolves which project ID to use when the request targets a customer.
 *
 * Most calls use the API key's project as context, so the project is already known. This
 * function handles the special case where the **customer being queried is Unprice's own
 * workspace** (the workspace that holds the Main Project). In that "self-reflection" case,
 * the customer record is owned by the Main Project, so we must return the Main Project's ID
 * instead of the default (caller's) project ID.
 *
 * @example Visual: normal vs self-reflection
 *
 *   NORMAL (third-party customer):
 *   ┌─────────────┐     customerId = "acme-customer"
 *   │ API Key     │     (different from this workspace's customer)
 *   │ Project A   │──────────────────────────────────────► return defaultProjectId (A)
 *   └─────────────┘
 *
 *   SELF-REFLECTION (Unprice querying its own usage):
 *   ┌─────────────────────────────────────────────────────────────────────────┐
 *   │ Unprice Workspace (has unPriceCustomerId = "unprice-self")             │
 *   │                                                                         │
 *   │   API Key ◄─── same workspace ───► customerId = "unprice-self"          │
 *   │     │                                        │                          │
 *   │     │ defaultProjectId                       │ customer record          │
 *   │     │ (could be any project                  │ is owned by              │
 *   │     │  in this workspace)                    ▼                          │
 *   │     │                              ┌──────────────────┐                 │
 *   │     └─────────────────────────────►│ Main Project     │◄── return this  │
 *   │                                    │ (owns customer)  │    project ID   │
 *   │                                    └──────────────────┘                 │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *
 * Resolution order for self-reflection (customerId === workspace's unPriceCustomerId):
 * 1. Use MAIN_PROJECT_ID from env when set (avoids DB round-trip).
 * 2. Otherwise load the customer from DB and use its projectId.
 *
 * For any other customerId, returns defaultProjectId (the project from the request context).
 */
export async function resolveContextProjectId(
  c: Context<HonoEnv>,
  defaultProjectId: string,
  customerId: string
) {
  const logger = c.get("logger")
  startTime(c, "resolveContextProjectId")

  const unPriceCustomerId = c.get("unPriceCustomerId")

  // Self-reflection: request is for the customer linked to this workspace (Unprice querying itself).
  if (unPriceCustomerId && customerId === unPriceCustomerId) {
    // Fast path: use env to avoid DB lookup.
    if (c.env.MAIN_PROJECT_ID) {
      endTime(c, "resolveContextProjectId")
      logger.set({
        business: {
          project_id: c.env.MAIN_PROJECT_ID,
        },
      })
      return c.env.MAIN_PROJECT_ID
    }

    // Fallback: resolve Main Project via customer record when env is not set.
    const { customer } = c.get("services")
    const { val } = await customer.getCustomer(customerId)

    if (val) {
      endTime(c, "resolveContextProjectId")
      logger.set({
        business: {
          project_id: val.projectId,
        },
      })
      return val.projectId
    }
  }

  // Normal case: third-party customer; use the project from the request context.
  logger.set({
    business: {
      project_id: defaultProjectId,
    },
  })
  endTime(c, "resolveContextProjectId")

  return defaultProjectId
}

export function validateIsAllowedToAccessProject({
  isMain,
  key,
  requestedProjectId,
}: {
  isMain: boolean
  key: ApiKeyExtended
  requestedProjectId: string
}) {
  const projectID = isMain
    ? requestedProjectId
      ? requestedProjectId
      : key.projectId
    : key.projectId

  if (!isMain && projectID !== key.projectId) {
    throw new UnpriceApiError({
      code: "FORBIDDEN",
      message: "You are not allowed to access this app analytics.",
    })
  }

  return projectID
}
