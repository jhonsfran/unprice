import { SchemaError } from "@unprice/error"
import type { Context } from "hono"
import { endTime, startTime } from "hono/timing"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

/**
 * keyAuth takes the bearer token from the request and verifies the key
 *
 * if the key doesnt exist, isn't valid or isn't a root key, an error is thrown, which gets handled
 * automatically by hono
 */
export async function keyAuth(c: Context<HonoEnv>) {
  const authorization = c.req.header("authorization")?.replace("Bearer ", "")
  const wideEventHelpers = c.get("wideEventHelpers")

  if (!authorization) {
    throw new UnpriceApiError({ code: "UNAUTHORIZED", message: "key required" })
  }

  const { apikey } = c.get("services")

  // start timer
  startTime(c, "verifyApiKey")

  // quick off in parallel (reducing p95 latency)
  const [rateLimited, verifyRes] = await Promise.all([
    apikey.rateLimit({
      key: authorization,
      workspaceId: c.get("workspaceId") as string,
      source: "cloudflare",
      limiter: c.env.RL_FREE_600_60s,
    }),
    apikey.verifyApiKey({ key: authorization }),
  ])

  // end timer
  endTime(c, "verifyApiKey")

  if (!rateLimited) {
    wideEventHelpers.addRateLimited(true)
    throw new UnpriceApiError({ code: "RATE_LIMITED", message: "apikey rate limit exceeded" })
  }

  const { val: key, err } = verifyRes

  if (err) {
    switch (true) {
      case err instanceof SchemaError:
        throw new UnpriceApiError({
          code: "BAD_REQUEST",
          message: err.message,
        })
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

  c.set("isMain", key.project.isMain ?? false)
  c.set("isInternal", key.project.isInternal ?? false)
  c.set("workspaceId", key.project.workspaceId)
  c.set("projectId", key.project.id)
  c.set("unPriceCustomerId", key.project.workspace.unPriceCustomerId)

  wideEventHelpers.addBusiness({
    project_id: key.project.id,
    workspace_id: key.project.workspaceId,
    is_main: key.project.isMain ?? false,
    is_internal: key.project.isInternal ?? false,
    unprice_customer_id: key.project.workspace.unPriceCustomerId,
  })

  return key
}

/**
 * Resolves the project ID for a customer.
 * If the customer is the project itself (acting as a customer of the Main Project),
 * it resolves the ID of the project that owns the customer (the Main Project).
 */
export async function resolveContextProjectId(
  c: Context<HonoEnv>,
  defaultProjectId: string,
  customerId: string
) {
  const wideEventHelpers = c.get("wideEventHelpers")
  startTime(c, "resolveContextProjectId")

  const unPriceCustomerId = c.get("unPriceCustomerId")

  // If the request is for the customer ID linked to this workspace (self-reflection)
  if (unPriceCustomerId && customerId === unPriceCustomerId) {
    // If we have the main project ID configured, use it directly (Zero Latency)
    if (c.env.MAIN_PROJECT_ID) {
      endTime(c, "resolveContextProjectId")
      wideEventHelpers.addBusiness({ project_id: c.env.MAIN_PROJECT_ID })
      return c.env.MAIN_PROJECT_ID
    }

    // Fallback: DB lookup if env var is missing (just in case)
    const { customer } = c.get("services")
    const { val } = await customer.getCustomer(customerId)

    if (val) {
      endTime(c, "resolveContextProjectId")
      wideEventHelpers.addBusiness({ project_id: val.projectId })
      return val.projectId
    }
  }

  wideEventHelpers.addBusiness({ project_id: defaultProjectId })
  endTime(c, "resolveContextProjectId")

  return defaultProjectId
}
