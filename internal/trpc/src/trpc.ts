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
import type { Logger } from "@unprice/logs"
import { createStandaloneRequestLogger } from "@unprice/observability"
import { shouldEmitMetrics } from "@unprice/observability/env"
import type { CacheNamespaces } from "@unprice/services/cache"
import { CacheService, createRedis } from "@unprice/services/cache"
import { type ServiceContext, createServiceContext } from "@unprice/services/context"
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

type TrpcProcedureLog = {
  duration_ms: number
  error_code?: string
  ok: boolean
  path: string
  route: string
  status: number
}

type TrpcRequestSummary = {
  failed_count: number
  max_duration_ms: number
  procedure_count: number
  procedures: TrpcProcedureLog[]
  status: number
  total_duration_ms: number
}

function roundDurationMs(duration: number): number {
  return Math.round(duration * 100) / 100
}

function createTrpcProcedureLog(
  path: string,
  duration: number,
  status: number,
  errorCode?: string
): TrpcProcedureLog {
  const procedure: TrpcProcedureLog = {
    duration_ms: roundDurationMs(duration),
    ok: status < 400,
    path,
    route: `/trpc/${path}`,
    status,
  }

  if (errorCode) {
    procedure.error_code = errorCode
  }

  return procedure
}

function summarizeTrpcProcedures(procedures: TrpcProcedureLog[]): TrpcRequestSummary {
  const failedCount = procedures.filter((procedure) => !procedure.ok).length
  const durations = procedures.map((procedure) => procedure.duration_ms)
  const statuses = procedures.map((procedure) => procedure.status)

  return {
    failed_count: failedCount,
    max_duration_ms: Math.max(...durations),
    procedure_count: procedures.length,
    procedures,
    status: Math.max(...statuses),
    total_duration_ms: roundDurationMs(durations.reduce((total, duration) => total + duration, 0)),
  }
}

/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API
 */
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
  // accumulated procedure logs for enriching the parent wide event
  _procedures: TrpcProcedureLog[]
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
  services: ServiceContext
} => {
  const analytics = new Analytics({
    tinybirdToken: env.TINYBIRD_TOKEN,
    tinybirdUrl: env.TINYBIRD_URL,
    emit: true,
    logger: opts.logger,
  })

  const services = createServiceContext({
    db,
    logger: opts.logger,
    analytics,
    waitUntil: opts.waitUntil,
    cache: opts.cache,
    metrics: opts.metrics,
  })

  return {
    ...opts,
    db: db,
    analytics,
    services,
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
  logger?: Logger
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
  const methodHeader = opts.req?.method ?? opts.opts?.method ?? "GET"
  const method =
    methodHeader === "GET" ||
    methodHeader === "POST" ||
    methodHeader === "PUT" ||
    methodHeader === "PATCH" ||
    methodHeader === "DELETE" ||
    methodHeader === "OPTIONS"
      ? methodHeader
      : "GET"
  const portHeader = opts.headers.get("x-forwarded-port") ?? opts.headers.get("port")
  const port =
    portHeader && /^[0-9]+$/.test(portHeader) ? Number.parseInt(portHeader, 10) : undefined
  const protocolHeader = opts.headers.get("x-forwarded-proto") ?? opts.headers.get("protocol")
  const protocol =
    protocolHeader === "http" || protocolHeader === "https" ? protocolHeader : undefined

  const emitMetrics = shouldEmitMetrics(env)

  // Use the logger passed in from Next.js (evlog/next) or create a standalone one
  const fallback = createStandaloneRequestLogger(
    { method, path: pathname, requestId },
    { flush: () => Promise.resolve() }
  )
  const logger = opts.logger ?? fallback.logger

  const metrics: Metrics = emitMetrics
    ? new LogdrainMetrics({
        requestId,
        logger,
        environment: env.NODE_ENV,
        service: "trpc",
        colo: region,
      })
    : new NoopMetrics()

  const cacheService = new CacheService({ waitUntil }, metrics, emitMetrics)

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

  const activeWorkspaceSlug =
    opts.req?.cookies.get(COOKIES_APP.WORKSPACE)?.value ??
    opts.headers.get(COOKIES_APP.WORKSPACE) ??
    ""

  const activeProjectSlug =
    opts.req?.cookies.get(COOKIES_APP.PROJECT)?.value ?? opts.headers.get(COOKIES_APP.PROJECT) ?? ""

  logger.set({
    request: {
      id: requestId,
      timestamp: new Date().toISOString(),
      method,
      path: pathname,
      referer: opts.headers.get("referer") ?? undefined,
      host: opts.headers.get("host") ?? undefined,
      port,
      protocol,
      query: opts.req?.nextUrl.search ? opts.req.nextUrl.search.replace(/^\?/, "") : undefined,
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
  })

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
    waitUntil,
    hashCache,
    geolocation: {
      continent,
      country,
      region,
      city,
      ip,
    },
    _procedures: [],
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
 */
export const createTRPCRouter = t.router
export const mergeRouters = t.mergeRouters

/**
 * Public procedure - enriches the parent wide event with tRPC procedure summary
 */
export const publicProcedure = t.procedure.use(async ({ ctx, next, path }) => {
  const start = performance.now()
  let status = 200
  let errorCode: string | undefined

  try {
    const result = await next()

    if (!result.ok) {
      status = getHttpStatus(result.error.code)
      errorCode = result.error.code
      ctx.logger.set({
        error: { trpc_code: result.error.code },
      })
      ctx.logger.error(result.error, {
        context: "trpc.procedure_failed",
        path,
        status,
        trpc_code: result.error.code,
        message: result.error.message,
      })
    }

    return result
  } catch (err) {
    if (err instanceof TRPCError) {
      status = getHttpStatus(err.code)
      errorCode = err.code
      ctx.logger.set({
        error: { trpc_code: err.code },
      })
      ctx.logger.error(err)
    } else {
      status = 500
      errorCode = "INTERNAL_SERVER_ERROR"
      ctx.logger.error(err instanceof Error ? err : String(err))
    }
    throw err
  } finally {
    const duration = performance.now() - start
    const procedure = createTrpcProcedureLog(path, duration, status, errorCode)
    ctx._procedures.push(procedure)

    const summary = summarizeTrpcProcedures(ctx._procedures)

    // Enrich the parent wide event with the tRPC summary
    ctx.logger.set({
      business: {
        operation: summary.procedure_count === 1 ? path : "trpc.batch",
      },
      trpc: summary,
    })
  }
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

  ctx.logger.set({
    business: { user_id: ctx.session.user.id },
  })

  return next({
    ctx: {
      userId: ctx.session?.user.id,
      session: { ...ctx.session },
    },
  })
})

export const protectedWorkspaceProcedure = protectedProcedure.use(
  async ({ ctx, next, getRawInput }) => {
    const input = (await getRawInput()) as { workspaceSlug?: string }
    const activeWorkspaceSlug = input?.workspaceSlug ?? ctx.activeWorkspaceSlug

    const data = await workspaceGuard({
      workspaceSlug: activeWorkspaceSlug,
      ctx,
    })

    ctx.logger.set({
      business: { workspace_id: data.workspace.id },
    })

    return next({
      ctx: { ...data, session: { ...ctx.session } },
    })
  }
)

export const protectedProjectProcedure = protectedProcedure.use(
  async ({ ctx, next, getRawInput }) => {
    const input = (await getRawInput()) as { projectSlug?: string }
    const activeProjectSlug = input?.projectSlug ?? ctx.activeProjectSlug ?? undefined

    const data = await projectWorkspaceGuard({
      projectSlug: activeProjectSlug,
      ctx,
    })

    ctx.logger.set({
      business: {
        project_id: data.project.id,
        is_internal: data.project.isInternal ?? undefined,
        is_main: data.project.isMain ?? undefined,
        workspace_id: data.project.workspaceId,
        unprice_customer_id: data.project.workspace.unPriceCustomerId ?? undefined,
      },
    })

    return next({
      ctx: { ...data, session: { ...ctx.session } },
    })
  }
)

export type Context = Awaited<ReturnType<typeof createTRPCContext>>
