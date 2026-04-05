import type { Analytics } from "@unprice/analytics"
import { hashStringSHA256, newId } from "@unprice/db/utils"
import type { ApiKey, ApiKeyExtended, SearchParamsDataTable } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, type SchemaError, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { Cache } from "@unprice/services/cache"
import type { Metrics } from "@unprice/services/metrics"

import type { Database } from "@unprice/db"
import { and, count, eq, getTableColumns, ilike } from "@unprice/db"
import { apikeys } from "@unprice/db/schema"
import { withDateFilters, withPagination } from "@unprice/db/utils"
import { cachedQuery } from "../utils/cached-query"
import { toErrorContext } from "../utils/log-context"
import { UnPriceApiKeyError } from "./errors"

export type ApiKeyLimiter = {
  limit: (opts: { key: string }) => Promise<{ success: boolean }>
}

export class ApiKeysService {
  private readonly cache: Cache
  private readonly metrics: Metrics
  private readonly logger: Logger
  private readonly analytics: Analytics
  private hashCache: Map<string, string>
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private readonly db: Database
  constructor(opts: {
    cache: Cache
    metrics: Metrics
    analytics: Analytics
    logger: Logger
    db: Database
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    hashCache: Map<string, string>
  }) {
    this.cache = opts.cache
    this.metrics = opts.metrics
    this.analytics = opts.analytics
    this.logger = opts.logger
    this.db = opts.db
    this.waitUntil = opts.waitUntil
    this.hashCache = opts.hashCache
  }

  public async listApiKeysByProject({
    projectId,
    query,
  }: {
    projectId: string
    query: SearchParamsDataTable
  }): Promise<Result<{ apikeys: ApiKey[]; pageCount: number }, FetchError>> {
    const { page, page_size, search, from, to } = query
    const columns = getTableColumns(apikeys)
    const filter = `%${search}%`

    const expressions = [
      search ? ilike(columns.name, filter) : undefined,
      projectId ? eq(columns.projectId, projectId) : undefined,
    ]

    const { val, err } = await wrapResult(
      this.db.transaction(async (tx) => {
        const query = tx.select().from(apikeys).$dynamic()
        const whereQuery = withDateFilters<ApiKey>(expressions, columns.createdAtM, from, to)

        const data = await withPagination(
          query,
          whereQuery,
          [
            {
              column: columns.createdAtM,
              order: "desc",
            },
          ],
          page,
          page_size
        )

        const total = await tx
          .select({
            count: count(),
          })
          .from(apikeys)
          .where(whereQuery)
          .execute()
          .then((res) => res[0]?.count ?? 0)

        return {
          data,
          total,
        }
      }),
      (error) =>
        new FetchError({
          message: `error listing api keys by project: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error listing api keys by project", {
        error: toErrorContext(err),
        projectId,
      })
      return Err(err)
    }

    const pageCount = Math.ceil(val.total / page_size)

    return Ok({
      apikeys: val.data as ApiKey[],
      pageCount,
    })
  }

  // in memory cache with size and TTL limits
  // kid of hard to reach the limit as cloudflare can hit others isolates
  // but just in case we limit it to 1000 entries
  private updateCache(key: string, result: string) {
    // enforce max size - remove oldest entry if at limit
    if (this.hashCache.size >= 1000) {
      // remove first (oldest) entry
      const firstKey = this.hashCache.keys().next().value
      if (firstKey) {
        this.hashCache.delete(firstKey)
      }
    }

    this.hashCache.set(key, result)
  }

  private async hash(key: string): Promise<string> {
    const cached = this.hashCache.get(key)
    if (cached) {
      return cached
    }
    const hash = await hashStringSHA256(key)
    // we don't want to use swr here as it doesn't make sense to do a network call to the cache if there is miss
    // only improve a little bit of latency when hitting the same isolate in cloudflare
    this.updateCache(key, hash)
    return hash
  }

  private async getData(keyHash: string): Promise<ApiKeyExtended | null> {
    const data = await this.db.query.apikeys
      .findFirst({
        with: {
          project: {
            columns: {
              workspaceId: true,
              id: true,
              enabled: true,
              slug: true,
              defaultCurrency: true,
              isMain: true,
              isInternal: true,
              timezone: true,
            },
            with: {
              workspace: {
                columns: {
                  enabled: true,
                  unPriceCustomerId: true,
                  isPersonal: true,
                  isInternal: true,
                  isMain: true,
                  createdBy: true,
                },
              },
            },
          },
        },
        columns: {
          id: true,
          projectId: true,
          expiresAt: true,
          revokedAt: true,
          hash: true,
        },
        where: (apikey, { eq }) => eq(apikey.hash, keyHash),
      })
      .catch((e) => {
        this.logger.set({ error: toErrorContext(e) })
        this.logger.error(`Error fetching apikey from db: ${e.message}`, {
          error: toErrorContext(e),
          keyHash,
        })

        return null
      })

    if (!data) {
      return null
    }

    // update last used at
    // this is not awaited to avoid blocking the request
    // also this is updated only when the apikey is fetched from the db
    this.waitUntil(
      this.db
        .update(apikeys)
        .set({
          lastUsed: Date.now(),
        })
        .where(and(eq(apikeys.id, data.id), eq(apikeys.projectId, data.projectId)))
    )

    return data
  }

  public async getApiKey(
    req: {
      key: string
    },
    opts: {
      skipCache?: boolean
    }
  ): Promise<Result<ApiKeyExtended, SchemaError | FetchError | UnPriceApiKeyError>> {
    const keyHash = await this.hash(req.key)

    if (opts?.skipCache) {
      this.logger.info("force skipping cache for getApiKey", {
        keyHash,
      })
    }

    const { val: data, err } = await cachedQuery({
      skipCache: opts?.skipCache,
      cache: this.cache.apiKeyByHash,
      cacheKey: keyHash,
      load: () => this.getData(keyHash),
      wrapLoadError: (err) =>
        new FetchError({
          message: `unable to query db, ${err.message}`,
          retry: false,
          context: {
            error: err.message,
            url: "",
            method: "",
            keyHash,
          },
        }),
      onRetry: (attempt, err) => {
        this.logger.warn("Failed to fetch key data, retrying... getApiKey", {
          hash: keyHash,
          attempt,
          error: toErrorContext(err),
        })
      },
    })

    if (err) {
      return Err(
        new FetchError({
          message: `unable to fetch getApiKey, ${err.message}`,
          retry: false,
          cause: err,
        })
      )
    }

    if (!data) {
      return Err(
        new UnPriceApiKeyError({
          code: "NOT_FOUND",
          message: "apikey not found",
        })
      )
    }

    return Ok(data)
  }

  public async verifyApiKey(req: {
    key: string
  }): Promise<Result<ApiKeyExtended, UnPriceApiKeyError | FetchError | SchemaError>> {
    try {
      const { key } = req

      const result = await this.getApiKey(
        {
          key,
        },
        {
          skipCache: false,
        }
      ).catch(async (err) => {
        this.logger.error(`verify error, retrying without cache, ${err.message}`, {
          error: toErrorContext(err),
        })

        await this.cache.apiKeyByHash.remove(await this.hash(req.key))
        return await this.getApiKey(
          {
            key,
          },
          {
            skipCache: true,
          }
        )
      })

      if (result.err) {
        this.logger.error("Error verifying apikey after retrying without cache", {
          error: toErrorContext(result.err),
        })

        return result
      }

      const apiKey = result.val

      if (apiKey.revokedAt && apiKey.revokedAt < Date.now()) {
        return Err(
          new UnPriceApiKeyError({
            code: "REVOKED",
            message: "apikey revoked",
          })
        )
      }

      if (apiKey.expiresAt && apiKey.expiresAt < Date.now()) {
        return Err(
          new UnPriceApiKeyError({
            code: "EXPIRED",
            message: "apikey expired",
          })
        )
      }

      if (apiKey.project.enabled === false) {
        return Err(
          new UnPriceApiKeyError({
            code: "PROJECT_DISABLED",
            message: "apikey project disabled",
          })
        )
      }

      if (apiKey.project.workspace.enabled === false) {
        return Err(
          new UnPriceApiKeyError({
            code: "WORKSPACE_DISABLED",
            message: "apikey workspace disabled",
          })
        )
      }

      return Ok(apiKey)
    } catch (e) {
      const error = e as Error
      this.logger.error("Unhandled error while getting the apikey", {
        error: toErrorContext(error),
      })

      return Err(
        new UnPriceApiKeyError({
          code: "UNHANDLED_ERROR",
          message: "unhandled error",
        })
      )
    }
  }

  public async rollApiKey(req: {
    keyHash: string
  }): Promise<Result<ApiKey & { newKey: string }, SchemaError | FetchError | UnPriceApiKeyError>> {
    const apiKey = await this.getData(req.keyHash)

    if (!apiKey) {
      return Err(
        new UnPriceApiKeyError({
          code: "NOT_FOUND",
          message: "apikey not found",
        })
      )
    }

    if (apiKey.revokedAt && apiKey.revokedAt < Date.now()) {
      return Err(
        new UnPriceApiKeyError({
          code: "REVOKED",
          message: "apikey is revoked",
        })
      )
    }

    const newKey = newId("apikey_key")
    // generate hash of the key
    const apiKeyHash = await hashStringSHA256(newKey)

    const newApiKey = await this.db
      .update(apikeys)
      .set({ updatedAtM: Date.now(), hash: apiKeyHash })
      .where(eq(apikeys.id, apiKey.id))
      .returning()
      .then((res) => res[0])

    if (!newApiKey) {
      return Err(
        new FetchError({
          message: "Failed to update API key",
          retry: false,
        })
      )
    }

    const newApiKeyExtended = {
      ...newApiKey,
      newKey,
    }

    // update cache
    this.waitUntil(
      this.cache.apiKeyByHash.set(apiKeyHash, {
        ...apiKey,
        ...newApiKey,
      })
    )

    return Ok(newApiKeyExtended)
  }

  /**
   * Applies rate limiting for a given API key and records metrics.
   *
   * @param req.limiter - Implementation of the rate limiter used to enforce limits.
   * @param req.key - Raw API key string used to identify the caller (hashed internally).
   * @param req.workspaceId - Optional workspace identifier for metric attribution.
   * @param req.source - Logical source of the request (e.g. "public-api").
   * @param req.path - Optional request path for more granular metric tagging.
   *
   * @returns A boolean indicating whether the request has been rate limited.
   * `true` means the request is limited (not allowed); `false` means it is allowed.
   */
  public async rateLimit(req: {
    limiter: ApiKeyLimiter
    key: string
    workspaceId?: string
    source: string
    path?: string
  }) {
    // hash the key
    const keyHash = await this.hash(req.key)
    const start = performance.now()
    // emits true if it's allowed
    const result = await req.limiter.limit({ key: keyHash })
    const end = performance.now()
    const workspaceId = req.workspaceId ?? "unknown"

    // emit metrics (both allowed and limited)
    this.waitUntil(
      Promise.resolve(
        this.metrics.emit({
          metric: "metric.ratelimit",
          workspaceId,
          identifier: keyHash,
          latency: end - start,
          mode: req.source,
          path: req.path,
          success: result.success,
          error: !result.success,
          source: req.source,
        })
      )
    )

    // Cloudflare RateLimit bindings return { success: true } when the request is allowed.
    return !result.success
  }
}
