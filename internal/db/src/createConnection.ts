import { Pool, neon, neonConfig } from "@neondatabase/serverless"
import type { Logger } from "drizzle-orm"
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http"
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless"
import { withReplicas } from "drizzle-orm/pg-core"
import ws from "ws"
import type { Database, HttpDatabase } from "."
import * as schema from "./schema"

export type ConnectionDatabaseOptions = {
  env: "development" | "production" | "test" | "preview"
  primaryDatabaseUrl: string
  read1DatabaseUrl?: string
  read2DatabaseUrl?: string
  logger: boolean
  singleton?: boolean
}

class MyLogger implements Logger {
  logQuery(query: string, params?: unknown[]): void {
    console.info("=".repeat(40))
    console.info("\n\x1b[36m[Drizzle]\x1b[0m\n")
    console.info(`Query:\n${query}\n`)

    if (params && params.length > 0) {
      console.info(`Params:\n${JSON.stringify(params, null, 2)}\n`)
    }
    console.info("=".repeat(40))
  }
}

// only for development when using node 20
neonConfig.webSocketConstructor = typeof WebSocket !== "undefined" ? WebSocket : ws

/**
 * Upper bound for a single Neon HTTP query (`neon()` / `createHttpConnection`). The WebSocket
 * `Pool` has its own connection and query timeouts, but the HTTP driver has none, so a stalled
 * request would otherwise hang the caller (for example the API key verification hot path).
 */
export const HTTP_QUERY_TIMEOUT_MS = 5_000

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const FETCH_TIMEOUT_MARKER = Symbol.for("unprice.db.neonHttpFetchTimeout")

/**
 * Wraps a fetch implementation so every request is aborted after `timeoutMs`. A caller supplied
 * `init.signal` is still honoured: whichever aborts first wins.
 */
export function withFetchTimeout(baseFetch: FetchFn, timeoutMs: number): FetchFn {
  const wrapped: FetchFn = (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    return baseFetch(input, { ...init, signal })
  }
  Object.defineProperty(wrapped, FETCH_TIMEOUT_MARKER, { value: true })
  return wrapped
}

/**
 * Installs the timeout on `neonConfig.fetchFunction`, which is global to the Neon driver. It is
 * idempotent: calling it again never wraps the wrapper. `poolQueryViaFetch` stays off, so only
 * HTTP clients go through this fetch; `Pool` queries keep using WebSockets.
 */
export function installHttpQueryTimeout(): void {
  const current = neonConfig.fetchFunction as FetchFn | undefined
  if (current && (current as unknown as Record<symbol, unknown>)[FETCH_TIMEOUT_MARKER]) {
    return
  }

  // Resolve the global fetch lazily so runtime or test replacements are picked up.
  const baseFetch: FetchFn = current ?? ((input, init) => fetch(input, init))
  neonConfig.fetchFunction = withFetchTimeout(baseFetch, HTTP_QUERY_TIMEOUT_MS)
  neonConfig.poolQueryViaFetch = false
}

// Module-level singleton cache for the database connection proxy
// Used when opts.singleton is true to avoid creating multiple connection instances
let db: Database | null = null

/**
 * Creates a database connection to Neon PostgreSQL with support for read replicas.
 *
 * This function is designed to work across multiple serverless environments:
 * - Cloudflare Workers
 * - Vercel Edge/Serverless Functions
 * - Trigger.dev workers
 * - Local Node.js development
 *
 * Key features:
 * - Lazy initialization: Connection is only established on first use (not at import time)
 * - Singleton mode: Optionally reuses the same connection across calls
 * - Read replicas: In production, distributes read queries across replica databases
 * - WebSocket support: Uses ws polyfill for Node.js environments without native WebSocket
 */
export function createConnection(opts: ConnectionDatabaseOptions): Database {
  // Return cached singleton if already initialized and singleton mode is requested
  if (db && opts.singleton) {
    return db as Database
  }

  /**
   * Internal function that performs the actual database initialization.
   * This is called lazily by the proxy on first property access, not immediately.
   */
  const initDb = (): Database => {
    // because an error in cloudflare read1DatabaseUrl is equal to  """"
    // we need to parse that and make it a string
    if (
      opts.read1DatabaseUrl === undefined ||
      opts.read1DatabaseUrl === null ||
      opts.read1DatabaseUrl === ""
    ) {
      opts.read1DatabaseUrl = undefined
    }
    if (
      opts.read2DatabaseUrl === undefined ||
      opts.read2DatabaseUrl === null ||
      opts.read2DatabaseUrl === ""
    ) {
      opts.read2DatabaseUrl = undefined
    }

    if (opts.env === "development") {
      neonConfig.wsProxy = (host) => {
        return `${host}:5433/v1?address=db:5432`
      }

      neonConfig.useSecureWebSocket = false
      neonConfig.pipelineTLS = false
      neonConfig.pipelineConnect = false
    }

    const poolConfig = {
      connectionString: opts.primaryDatabaseUrl,
      connectionTimeoutMillis: 30000,
      keepAlive: true,
      // Add connection retry logic
      maxUses: 7500,
      idleTimeoutMillis: 30000,
      // Increase statement timeout for complex queries
      queryTimeout: 60000,
    }

    const primary = drizzleNeon(
      new Pool(poolConfig).on("error", (err: unknown) => {
        console.error("Database error:", err)
      }),
      {
        schema: schema,
        logger: opts.logger ? new MyLogger() : undefined,
      }
    )

    // Only create read replicas if URLs are provided and in production
    // This avoids creating unnecessary Pool connections with undefined connectionStrings
    if (opts.env === "production" && opts.read1DatabaseUrl && opts.read2DatabaseUrl) {
      // Fail fast when a replica cannot be reached, and log idle client errors instead of
      // letting them surface as unhandled errors.
      const replicaPoolConfig = {
        connectionTimeoutMillis: 5000,
      }

      const read1 = drizzleNeon(
        new Pool({
          ...replicaPoolConfig,
          connectionString: opts.read1DatabaseUrl,
        }).on("error", (err: unknown) => {
          console.error("Database read1 replica error:", err)
        }),
        {
          schema: schema,
        }
      )

      const read2 = drizzleNeon(
        new Pool({
          ...replicaPoolConfig,
          connectionString: opts.read2DatabaseUrl,
        }).on("error", (err: unknown) => {
          console.error("Database read2 replica error:", err)
        }),
        {
          schema: schema,
        }
      )

      return withReplicas(primary, [read1, read2])
    }

    // In non-production or without replicas, use primary for all reads
    return withReplicas(primary, [primary])
  }

  /**
   * Lazy Proxy Pattern for Database Connection
   *
   * This proxy defers the actual database connection initialization until the first
   * property access on the db object. This is critical for serverless environments like:
   * - Cloudflare Workers: Cannot make network connections during module initialization
   * - Vercel Edge Functions: Cold starts are faster when connections are deferred
   * - Trigger.dev: Workers may not need DB on every invocation
   *
   * How it works:
   * 1. `createConnection()` returns immediately with a lightweight proxy object
   * 2. The actual DB connection (`initDb()`) is only called when code first accesses
   *    any property on the proxy (e.g., `db.query`, `db.select`, etc.)
   * 3. Once initialized, `_lazyInstance` caches the real DB instance for subsequent access
   *
   * The proxy traps (get, has, ownKeys, getOwnPropertyDescriptor) ensure the proxy
   * behaves identically to the real Database object for all common operations.
   */
  let _lazyInstance: Database | null = null

  const proxy = new Proxy({} as Database, {
    get(_target, prop) {
      if (!_lazyInstance) {
        _lazyInstance = initDb()
      }
      return Reflect.get(_lazyInstance, prop)
    },
    has(_target, prop) {
      if (!_lazyInstance) {
        _lazyInstance = initDb()
      }
      return Reflect.has(_lazyInstance, prop)
    },
    ownKeys(_target) {
      if (!_lazyInstance) {
        _lazyInstance = initDb()
      }
      return Reflect.ownKeys(_lazyInstance)
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (!_lazyInstance) {
        _lazyInstance = initDb()
      }
      return Reflect.getOwnPropertyDescriptor(_lazyInstance, prop)
    },
  })

  // Cache the proxy at module level if singleton mode is enabled
  // This ensures all callers get the same lazy-initialized instance
  if (opts.singleton) {
    db = proxy as Database
  }

  return proxy as Database
}

// Module-level cache for HTTP connections, keyed by connection string and logger flag.
// Building a drizzle instance walks the whole schema to extract relations, so reuse it across
// requests in the same isolate. The HTTP client itself holds no open connection.
const httpConnections = new Map<string, HttpDatabase>()

export type HttpConnectionOptions = Pick<
  ConnectionDatabaseOptions,
  "env" | "primaryDatabaseUrl" | "logger"
>

/**
 * Creates a Drizzle client over the Neon HTTP driver (`neon()` + `drizzle-orm/neon-http`).
 *
 * Every query is a single HTTPS request, so there is no WebSocket upgrade or Postgres
 * startup/auth handshake per request. Use it for short, latency sensitive, single statement
 * work on hot paths (for example the uncached API key lookup). It does not support interactive
 * transactions; keep transactions on `createConnection`.
 *
 * It always targets the primary database, so a row written just before (for example a newly
 * created API key) is visible.
 *
 * Returns `null` in development: the local docker setup only runs the Neon WebSocket proxy, which
 * has no HTTP `/sql` endpoint. Callers should fall back to `createConnection` in that case.
 */
export function createHttpConnection(opts: HttpConnectionOptions): HttpDatabase | null {
  if (opts.env === "development" || !opts.primaryDatabaseUrl) {
    return null
  }

  const cacheKey = `${opts.logger ? "1" : "0"}:${opts.primaryDatabaseUrl}`
  const cached = httpConnections.get(cacheKey)
  if (cached) {
    return cached
  }

  installHttpQueryTimeout()

  const httpDb = drizzleNeonHttp(neon(opts.primaryDatabaseUrl), {
    schema: schema,
    logger: opts.logger ? new MyLogger() : undefined,
  })

  httpConnections.set(cacheKey, httpDb)

  return httpDb
}
