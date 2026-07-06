import type { Context, Env, MiddlewareHandler } from "hono"

export type IdempotencyClaimResult =
  | { status: "claimed" }
  | { status: "replayed"; response: Response }
  | { status: "in_flight" }

export type IdempotencyStore<TEnv extends Env = Env> = {
  getKey: (c: Context<TEnv>) => string | null
  claim: (key: string) => Promise<IdempotencyClaimResult>
  save: (key: string, response: Response) => Promise<void>
  release: (key: string) => Promise<void>
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

async function releaseWithoutMasking<TEnv extends Env>(
  store: IdempotencyStore<TEnv>,
  key: string
): Promise<void> {
  try {
    await store.release(key)
  } catch {
    // Preserve the downstream error or response; this middleware has no logger dependency.
  }
}

export function createHttpIdempotencyMiddleware<TEnv extends Env = Env>(
  store: IdempotencyStore<TEnv>
): MiddlewareHandler<TEnv> {
  return async (c, next) => {
    if (!MUTATING_METHODS.has(c.req.method.toUpperCase())) {
      await next()
      return
    }

    const key = store.getKey(c)
    if (!key) {
      await next()
      return
    }

    const claim = await store.claim(key)
    if (claim.status === "replayed") {
      return claim.response.clone()
    }

    if (claim.status === "in_flight") {
      return c.json(
        {
          code: "IDEMPOTENCY_IN_FLIGHT",
          message: "Request already in progress",
        },
        409
      )
    }

    try {
      await next()
    } catch (error) {
      await releaseWithoutMasking(store, key)
      throw error
    }

    const response = c.res.clone()
    if (response.status >= 500) {
      await releaseWithoutMasking(store, key)
      return
    }

    if (response.status < 400 || response.status === 409) {
      try {
        await store.save(key, response)
      } catch (error) {
        await releaseWithoutMasking(store, key)
        throw error
      }
      return
    }

    await releaseWithoutMasking(store, key)
  }
}
