import "server-only"

import { TRPCError, initTRPC } from "@trpc/server"
import type { Cache as C } from "@unkey/cache"
import { UpstashRedisStore } from "@unkey/cache/stores"
import { Analytics } from "@unprice/analytics"
import type { NextAuthRequest } from "@unprice/auth"
import type { Session } from "@unprice/auth/server"
import { auth } from "@unprice/auth/server"
import { COOKIES_APP } from "@unprice/config"
import type { Database } from "@unprice/db"
import { newId } from "@unprice/db/utils"
import {
  AxiomLogger,
  ConsoleLogger,
  type Logger,
  type WideEventHelpers,
  type WideEventInput,
  type WideEventLogger,
  createWideEventHelpers,
  createWideEventLogger,
} from "@unprice/logging"
import type { CacheNamespaces } from "@unprice/services/cache"
import { CacheService, createRedis } from "@unprice/services/cache"
import { LogdrainMetrics, type Metrics, NoopMetrics } from "@unprice/services/metrics"
import { waitUntil } from "@vercel/functions"
import { ZodError } from "zod"
import { fromZodError } from "zod-validation-error"
import { env } from "./env"
import { transformer } from "./transformer"
import { db } from "./utils/db"
import { getHttpStatus } from "./utils/get-status"
import { projectWorkspaceGuard } from "./utils/project-workspace-guard"
import { workspaceGuard } from "./utils/workspace-guard"

// this is a cache between request executions
const hashCache = new Map()
/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API
 *
 * These allow you to access things like the database, the session, etc, when
 * processing a request
 *
 */
/** Payload for the wide event, populated at context creation and applied when the procedure runs inside runAsync */
export interface WideEventRequestPayload {
  request: {
    id: string
    timestamp: string
    method: string
    path: string
    referer?: string
    host?: string
    port?: string
    protocol?: string
    headers?: string
    query?: string
  }
  cloud: { platform: string; region: string }
  geo: {
    colo: string
    country: string
    continent: string
    city: string
    ip: string
    ua: string
    source: string
  }
  business: { user_id: string }
}

export interface CreateContextOptions {
  headers: Headers
  session: Session | null
  req?: NextAuthRequest
  activeWorkspaceSlug: string
  activeProjectSlug: string
  requestId: string
  logger: Logger
  metrics: Metrics
  cache: C<CacheNamespaces>
  // pass this in the context so we can migrate easily to other providers
  waitUntil: (p: Promise<unknown>) => void
  hashCache: Map<string, string>
  geolocation: {
    continent: string
    country: string
    region: string
    city: string
    ip: string
  }
  wideEventLogger: WideEventLogger
  wideEventHelpers: WideEventHelpers
  /** Passed to the procedure so it can addMany once inside runAsync (addMany is a no-op outside a run context) */
  wideEventRequestPayload: WideEventRequestPayload
}

/**
 * This helper generates the "internals" for a tRPC context. If you need to use
 * it, you can export it from here
 */
export const createInnerTRPCContext = (
  opts: CreateContextOptions
): CreateContextOptions & {
  db: Database
  analytics: Analytics
} => {
  return {
    ...opts,
    db: db,
    analytics: new Analytics({
      tinybirdToken: env.TINYBIRD_TOKEN,
      tinybirdUrl: env.TINYBIRD_URL,
      emit: env.EMIT_ANALYTICS,
      logger: opts.logger,
    }),
    // INFO: better wait for native support for RLS in Drizzle
    // txRLS: rls.authTxn(db, opts.session?.user.id),
  }
}

/**
 * This is the actual context you'll use in your router. It will be used to
 * process every request that goes through your tRPC endpoint
 */
export const createTRPCContext = async (opts: {
  headers: Headers
  session: Session | null
  req?: NextAuthRequest
  opts?: {
    continent: string
    country: string
    region: string
    city: string
    userAgent: string
    source: string
    pathname: string
    method: string
    ip: string
  }
}) => {
  const session = opts.session ?? (await auth())
  const userId = session?.user?.id || "unknown"
  const requestId =
    opts.headers.get("unprice-request-id") ||
    opts.headers.get("x-request-id") ||
    opts.headers.get("x-vercel-id") ||
    newId("request")
  const region = opts.opts?.region || opts.headers.get("x-vercel-id") || "unknown"
  const country = opts.opts?.country || opts.headers.get("x-vercel-ip-country") || "unknown"
  const continent = opts.opts?.continent || opts.headers.get("x-vercel-ip-continent") || "unknown"
  const city = opts.opts?.city || opts.headers.get("x-vercel-ip-city") || "unknown"
  const userAgent = opts.headers.get("user-agent") || "unknown"
  const ip =
    opts.opts?.ip ||
    opts.headers.get("x-real-ip") ||
    opts.headers.get("x-forwarded-for") ||
    "unknown"
  const source = opts.headers.get("unprice-request-source") || opts.opts?.source || "unknown"
  const pathname = opts.req?.nextUrl.pathname ?? opts.opts?.pathname ?? "unknown"
  const method = opts.req?.method ?? opts.opts?.method ?? "unknown"

  const logger = env.EMIT_METRICS_LOGS
    ? new AxiomLogger({
        apiKey: env.AXIOM_API_TOKEN,
        requestId,
        defaultFields: {
          userId,
          region,
          country,
          source,
          ip: ip === "::1" ? "127.0.0.1" : ip,
          pathname,
          userAgent,
          method,
        },
        dataset: env.AXIOM_DATASET,
        environment: env.NODE_ENV,
        service: "trpc",
        logLevel: env.VERCEL_ENV === "production" ? "warn" : "info",
      })
    : new ConsoleLogger({
        requestId,
        environment: env.NODE_ENV,
        logLevel: env.VERCEL_ENV === "production" ? "warn" : "info",
        service: "trpc",
        defaultFields: {
          userId,
          region,
          country,
          source,
          ip: ip === "::1" ? "127.0.0.1" : ip,
          pathname,
          userAgent,
          colo: region,
          continent,
          city,
          method,
        },
      })

  const metrics: Metrics = env.EMIT_METRICS_LOGS
    ? new LogdrainMetrics({
        requestId,
        logger,
        environment: env.NODE_ENV,
        service: "trpc",
        colo: region,
        sampleRate: 1,
      })
    : new NoopMetrics()

  // INFO: we have this problem that the store cache for TRPC
  // is different than the one in the API, if we need to invalidate
  // caches from trpc to API we need to expose workers cache API!
  const cacheService = new CacheService(
    {
      waitUntil,
    },
    metrics,
    env.EMIT_METRICS_LOGS
  )

  const upstashCacheStore =
    env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
      ? new UpstashRedisStore({
          redis: createRedis({
            token: env.UPSTASH_REDIS_REST_TOKEN,
            url: env.UPSTASH_REDIS_REST_URL,
            latencyLogging: env.NODE_ENV === "development",
          }),
        })
      : undefined

  cacheService.init(upstashCacheStore ? [upstashCacheStore] : [])

  const cache = cacheService.getCache()

  // this comes from the cookiesxa or headers of the request
  const activeWorkspaceSlug =
    opts.req?.cookies.get(COOKIES_APP.WORKSPACE)?.value ??
    opts.headers.get(COOKIES_APP.WORKSPACE) ??
    ""

  const activeProjectSlug =
    opts.req?.cookies.get(COOKIES_APP.PROJECT)?.value ?? opts.headers.get(COOKIES_APP.PROJECT) ?? ""

  const wideEventLogger = createWideEventLogger({
    "service.name": "trpc",
    "service.version": env.VERCEL_DEPLOYMENT_ID ?? "unknown",
    "service.environment": env.VERCEL_ENV as
      | "production"
      | "staging"
      | "development"
      | "test"
      | "preview",
    sampleRate: env.NODE_ENV === "production" ? 0.1 : 1,
    emitter: (level, message, event) => logger.emit(level, message, event),
  })

  const wideEventHelpers = createWideEventHelpers(wideEventLogger)

  // addMany is a no-op outside a run() context; we pass this payload so the procedure can
  // add it when it starts runAsync (that's when the wide-event context is active)
  const wideEventRequestPayload: WideEventRequestPayload = {
    request: {
      id: requestId,
      timestamp: new Date().toISOString(),
      method,
      path: pathname,
      referer: opts.headers.get("referer") ?? undefined,
      host: opts.headers.get("host") ?? undefined,
      port: opts.headers.get("port") ?? undefined,
      protocol: opts.headers.get("protocol") ?? undefined,
      headers: opts.headers.get("headers") ?? undefined,
      query: opts.headers.get("query") ?? undefined,
    },
    cloud: {
      platform: "vercel",
      region: env.VERCEL_REGION ?? "unknown",
    },
    geo: {
      colo: region,
      country,
      continent,
      city,
      ip,
      ua: userAgent,
      source,
    },
    business: {
      user_id: userId,
    },
  }

  return createInnerTRPCContext({
    session,
    headers: opts.headers,
    req: opts.req,
    activeWorkspaceSlug,
    activeProjectSlug,
    requestId,
    logger,
    metrics,
    cache,
    wideEventLogger,
    wideEventHelpers,
    wideEventRequestPayload,
    waitUntil, // abstracted to allow migration to other providers
    hashCache,
    geolocation: {
      continent,
      country,
      region,
      city,
      ip,
    },
  })
}

/**
 * 2. INITIALIZATION
 *
 * This is where the trpc api is initialized, connecting the context and
 * transformer
 */
export const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer,
  errorFormatter({ shape, error, ctx }) {
    // Note: Error details (including stack) are already captured in the middleware catch block
    // before this formatter runs. This ensures the error stack is included in the wideEvent
    // before it's flushed in the finally block.
    // The errorFormatter runs AFTER the middleware's finally block, so we can't add error details here.
    // don't show stack trace in production
    if (env.NODE_ENV === "production") {
      delete error.stack
      delete shape.data.stack
    }

    const errorResponse = {
      ...shape,
      data: {
        ...shape.data,
        code: error.code,
        cause: error.cause,
        requestId: ctx?.requestId,
        zodError:
          error.code === "BAD_REQUEST" && error.cause instanceof ZodError
            ? error.cause.flatten()
            : null,
      },
      message:
        error.cause instanceof ZodError ? fromZodError(error.cause).toString() : error.message,
    }

    return errorResponse
  },
})

/**
 * Create a server-side caller
 * @see https://trpc.io/docs/server/server-side-calls
 */
export const createCallerFactory = t.createCallerFactory

/**
 * 3. ROUTER & PROCEDURE (THE IMPORTANT BIT)
 *
 * These are the pieces you use to build your tRPC API. You should import these
 * a lot in the /src/server/api/routers folder
 */

/**
 * This is how you create new routers and subrouters in your tRPC API
 * @see https://trpc.io/docs/router
 */
export const createTRPCRouter = t.router
export const mergeRouters = t.mergeRouters

/**
 * Public procedure
 *
 * This is the base piece you use to build new queries and mutations on your
 * tRPC API. It does not guarantee that a user querying is authorized, but you
 * can still access user session data if they are logged in
 */
export const publicProcedure = t.procedure.use(async ({ ctx, next, path }) => {
  return await ctx.wideEventLogger.runAsync(async () => {
    const start = performance.now()

    // Add request/cloud/geo/business into the wide event now that we're inside runAsync.
    // addMany is a no-op when called outside a run context (e.g. in createTRPCContext).
    ctx.wideEventLogger.addMany(ctx.wideEventRequestPayload as unknown as WideEventInput)
    // Enrich with procedure name
    ctx.wideEventHelpers.addBusiness({ operation: path })
    ctx.wideEventHelpers.addRoute(`/trpc/${path}`)

    try {
      const result = await next()
      // 4. Capture Success or Error
      if (result.ok) {
        ctx.wideEventLogger.add("request.status", 200)
      } else {
        // tRPC errors are returned in result.error, not thrown
        const error = result.error
        const status = getHttpStatus(error.code)
        ctx.wideEventLogger.add("request.status", status)
        ctx.wideEventHelpers.addTrpcErrorCode(error.code)
        ctx.wideEventLogger.addError(error)
      }

      return result
    } catch (err) {
      // 5. Capture Error Details (TRPC Errors or standard Errors)
      if (err instanceof TRPCError) {
        ctx.wideEventLogger.add("request.status", getHttpStatus(err.code))
        ctx.wideEventHelpers.addTrpcErrorCode(err.code)
        ctx.wideEventLogger.addError(err)
      } else {
        ctx.wideEventLogger.add("request.status", 500)
        ctx.wideEventLogger.addError(err)
      }
      throw err
    } finally {
      ctx.wideEventLogger.add("request.duration", performance.now() - start)

      // flush the wide event
      ctx.waitUntil(
        Promise.all([ctx.wideEventLogger.emit(), ctx.metrics.flush(), ctx.logger.flush()])
      )
    }
  })
})

/**
 * Reusable procedure that enforces users are logged in before running the
 * procedure
 */
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.session?.user?.id) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "User not found in session" })
  }

  if (!ctx.session?.user?.email) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "User email not found in session" })
  }

  // Enrich wide event
  ctx.wideEventHelpers.addBusiness({ user_id: ctx.session.user.id })

  return next({
    ctx: {
      userId: ctx.session?.user.id,
      session: {
        ...ctx.session,
      },
    },
  })
})

// this is a procedure that requires a user to be logged in and have an active workspace
// it also sets the active workspace in the context
// the active workspace is passed in the headers or cookies of the request
// if the workspaceSlug is in the input, use it, otherwise use the active workspace slug in the cookie
export const protectedWorkspaceProcedure = protectedProcedure.use(
  async ({ ctx, next, getRawInput }) => {
    const input = (await getRawInput()) as { workspaceSlug?: string }
    const activeWorkspaceSlug = input?.workspaceSlug ?? ctx.activeWorkspaceSlug

    const data = await workspaceGuard({
      workspaceSlug: activeWorkspaceSlug,
      ctx,
    })

    // Enrich wide event
    ctx.wideEventHelpers.addBusiness({ workspace_id: data.workspace.id })

    return next({
      ctx: {
        ...data,
        session: {
          ...ctx.session,
        },
      },
    })
  }
)

export const protectedProjectProcedure = protectedProcedure.use(
  async ({ ctx, next, getRawInput }) => {
    const input = (await getRawInput()) as { projectSlug?: string }
    const activeProjectSlug = input?.projectSlug ?? ctx.activeProjectSlug ?? undefined

    // if projectSlug is present, use it if not use the active project slug
    const data = await projectWorkspaceGuard({
      projectSlug: activeProjectSlug,
      ctx,
    })

    // Enrich wide event
    ctx.wideEventHelpers.addBusiness({
      project_id: data.project.id,
      is_internal: data.project.isInternal ?? undefined,
      is_main: data.project.isMain ?? undefined,
      workspace_id: data.project.workspaceId,
      unprice_customer_id: data.project.workspace.unPriceCustomerId ?? undefined,
    })

    return next({
      ctx: {
        ...data,
        session: {
          ...ctx.session,
        },
      },
    })
  }
)

export type Context = Awaited<ReturnType<typeof createTRPCContext>>
