import type { ApiKeyExtended, ApiKeyType, Customer } from "@unprice/db/validators"
import { DEFAULT_API_KEY_TYPE } from "@unprice/db/validators"
import { SchemaError } from "@unprice/error"
import { UnPriceApiKeyError } from "@unprice/services/apikey"
import type { Context } from "hono"
import { endTime, startTime } from "hono/timing"
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

// verify is sensitive to latency
const API_KEY_RATE_LIMIT_BYPASS_PATHS = new Set(["/v1/access/check"])
const LIVE_API_KEY_PATTERN = /^unprice_live_[1-9A-HJ-NP-Za-km-z]{22}$/
const LOCAL_DEV_API_KEY_PATTERN = /^unprice_dev_[A-Za-z0-9_-]+$/

function isLocalhostUrl(url: string): boolean {
  const { hostname } = new URL(url)
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

export function isValidApiKeyShape(value: string, opts: { allowDevKey?: boolean } = {}): boolean {
  return (
    LIVE_API_KEY_PATTERN.test(value) ||
    (opts.allowDevKey === true && LOCAL_DEV_API_KEY_PATTERN.test(value))
  )
}

function normalizeRequestPath(path: string): string {
  return path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path
}

export function shouldBypassApiKeyRateLimit(path: string): boolean {
  return API_KEY_RATE_LIMIT_BYPASS_PATHS.has(normalizeRequestPath(path))
}

/**
 * keyAuth takes the bearer token from the request and verifies the key
 *
 * if the key doesnt exist or isn't valid, an error is thrown, which gets handled automatically
 * by hono
 *
 * `opts.requireType` picks the operation surface the route belongs to. It defaults to `runtime`,
 * so every existing route keeps rejecting config keys without changing its call.
 *
 * This is also where a cached key that predates the `type` column gets resolved, so callers
 * always receive a fully typed `ApiKeyExtended`.
 */
export async function keyAuth(
  c: Context<HonoEnv>,
  opts?: { requireType?: ApiKeyType }
): Promise<ApiKeyExtended> {
  const authHeader = c.req.header("authorization")?.trim()
  const authorization = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()

  if (!authorization) {
    throw new UnpriceApiError({ code: "UNAUTHORIZED", message: "key required" })
  }

  if (
    c.env.APP_ENV === "production" &&
    !isValidApiKeyShape(authorization, { allowDevKey: isLocalhostUrl(c.req.url) })
  ) {
    throw new UnpriceApiError({ code: "UNAUTHORIZED", message: "key not found" })
  }

  const { apikey } = c.get("services")
  const logger = c.get("logger")

  // start timer
  startTime(c, "verifyApiKey")

  const shouldAvoidRateLimit = c.env.APP_ENV === "development"
  const requestPath = normalizeRequestPath(c.req.path)
  const shouldBypassRateLimitPath = shouldBypassApiKeyRateLimit(requestPath)

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

  // A cache entry serialized before the `type` column shipped carries no type (see ApiKeyCache).
  // Those are runtime keys. This is the only place that resolves it.
  const keyType: ApiKeyType = key.type ?? DEFAULT_API_KEY_TYPE
  const requiredType: ApiKeyType = opts?.requireType ?? DEFAULT_API_KEY_TYPE

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
      api_key_id: key.id,
      api_key_type: keyType,
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
      logger.error(
        rateLimitError instanceof Error ? rateLimitError.message : String(rateLimitError ?? ""),
        {
          path: requestPath,
          workspaceId: key.project.workspaceId,
          context: "apikey rate limit check failed",
        }
      )
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

  // The message is identical in both directions on purpose: the caller must not learn which
  // key type this route wants. Because the rejection is opaque to the caller, it has to be
  // legible to us — a bare 403 is indistinguishable from every other FORBIDDEN in the logs.
  if (keyType !== requiredType) {
    logger.set({ error: { type: "INSUFFICIENT_PERMISSIONS" } })
    throw new UnpriceApiError({
      code: "INSUFFICIENT_PERMISSIONS",
      message: "this key is not allowed to call this operation",
    })
  }

  return { ...key, type: keyType }
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
    const { val } = await customer.getCustomerByIdAcrossProjects(customerId)

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

export type CustomerResolutionResult =
  | { success: true; customerId: string }
  | {
      success: false
      code: "customer_required" | "customer_forbidden"
      message: string
    }

export function resolveCustomerIdForApiKey(input: {
  explicitCustomerId?: string | null
  defaultCustomerId?: string | null
}): CustomerResolutionResult {
  const explicitCustomerId = input.explicitCustomerId ?? null
  const defaultCustomerId = input.defaultCustomerId ?? null

  if (defaultCustomerId !== null) {
    if (explicitCustomerId !== null && explicitCustomerId !== defaultCustomerId) {
      return {
        success: false,
        code: "customer_forbidden",
        message: "This API key is bound to a different customer",
      }
    }

    return { success: true, customerId: defaultCustomerId }
  }

  if (explicitCustomerId === null) {
    return {
      success: false,
      code: "customer_required",
      message: "customerId is required when the API key has no default customer binding",
    }
  }

  return { success: true, customerId: explicitCustomerId }
}

export function resolveCustomerIdForApiKeyOrThrow(input: {
  explicitCustomerId?: string | null
  defaultCustomerId?: string | null
}): string {
  const result = resolveCustomerIdForApiKey(input)

  if (!result.success) {
    throw new UnpriceApiError({
      code: result.code === "customer_forbidden" ? "FORBIDDEN" : "BAD_REQUEST",
      message: result.message,
    })
  }

  return result.customerId
}

export function validateIsAllowedToAccessProject({
  key,
  requestedProjectId,
}: {
  key: ApiKeyExtended
  requestedProjectId: string
}) {
  // Canonical "is main" predicate: a project is treated as main when either the
  // project itself or its workspace is flagged main. This is the single source of
  // truth — callers no longer pass their own (and previously divergent) boolean.
  const isMain = (key.project.isMain ?? false) || key.project.workspace.isMain

  if (isMain) {
    return requestedProjectId || key.projectId
  }

  if (!requestedProjectId || requestedProjectId === key.projectId) {
    return key.projectId
  }

  throw new UnpriceApiError({
    code: "FORBIDDEN",
    message: "You are not allowed to access a different project.",
  })
}

/**
 * Shared prologue for customer-scoped routes: authenticate the key, resolve the
 * target customer id (explicit or the key's default binding), resolve+authorize
 * the project, then load and existence-check the customer within that project.
 *
 * Replaces the 4-step block pasted across the wallet and payment-method routes.
 * Throws UnpriceApiError (mapped) on any failure.
 */
export async function resolveOwnedCustomer(
  c: Context<HonoEnv>,
  input: { customerId?: string | null; projectId?: string | null }
): Promise<{ key: ApiKeyExtended; customerId: string; projectId: string; customer: Customer }> {
  const key = await keyAuth(c)

  const customerId = resolveCustomerIdForApiKeyOrThrow({
    explicitCustomerId: input.customerId,
    defaultCustomerId: key.defaultCustomerId,
  })

  const projectId = validateIsAllowedToAccessProject({
    key,
    requestedProjectId: input.projectId ?? key.project.id ?? "",
  })

  const { val: customer, err } = await c.get("services").customer.getCustomerByIdInProject({
    id: customerId,
    projectId,
  })

  if (err) {
    throw toUnpriceApiError(err)
  }

  if (!customer || customer.projectId !== projectId) {
    throw new UnpriceApiError({ code: "NOT_FOUND", message: "Customer not found" })
  }

  return { key, customerId, projectId, customer }
}
