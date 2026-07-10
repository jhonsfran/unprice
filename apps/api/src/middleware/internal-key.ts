import type { MiddlewareHandler } from "hono"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

/**
 * Restricts every `/v1/internal/*` route to keys that belong to an internal or main project.
 *
 * These endpoints are called by our own services (billing, ingestion, etc.), never by tenants,
 * so any key that resolves to a regular project must be rejected before the handler runs.
 *
 * `keyAuth` authenticates the request and is safe to call again inside the handler — the second
 * call is served from the `apiKeyByHash` cache, so re-verifying there is cheap.
 */
export function internalKeyAuth(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const key = await keyAuth(c)

    if (!key.project.isInternal && !key.project.isMain) {
      throw new UnpriceApiError({
        code: "FORBIDDEN",
        message: "This key is not allowed to access internal endpoints",
      })
    }

    await next()
  }
}
