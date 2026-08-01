import type { Analytics } from "@unprice/analytics"
import { hashStringSHA256, newApiKeySecret, newId } from "@unprice/db/utils"
import type {
  ApiKey,
  ApiKeyExtended,
  ApiKeyType,
  SearchParamsDataTable,
} from "@unprice/db/validators"
import { DEFAULT_API_KEY_TYPE } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, type SchemaError, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { Cache } from "@unprice/services/cache"
import type { Metrics } from "@unprice/services/metrics"
import { fromZonedTime, toZonedTime } from "date-fns-tz"

import type { Database } from "@unprice/db"
import { and, count, eq, getTableColumns, ilike, inArray, isNull } from "@unprice/db"
import { apikeys } from "@unprice/db/schema"
import { withDateFilters, withPagination } from "@unprice/db/utils"
import type { ApiKeyCache } from "../cache/namespaces"
import { cachedQuery } from "../utils/cached-query"
import { toErrorContext } from "../utils/log-context"
import { UnPriceApiKeyError } from "./errors"

export type ApiKeyLimiter = {
  limit: (opts: { key: string }) => Promise<{ success: boolean }>
}

export const SDK_EXAMPLE_API_KEY_NAME = "SDK example key"

function endOfCurrentDayMs(timezone = "UTC") {
  try {
    const endOfDay = toZonedTime(new Date(), timezone)
    endOfDay.setHours(23, 59, 59, 999)
    return fromZonedTime(endOfDay, timezone).getTime()
  } catch {
    const endOfDay = new Date()
    endOfDay.setUTCHours(23, 59, 59, 999)
    return endOfDay.getTime()
  }
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
      this.logger.error(err, {
        context: "error listing api keys by project",
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

  public async createApiKey({
    projectId,
    isRoot,
    name,
    expiresAt,
    defaultCustomerId,
    type = DEFAULT_API_KEY_TYPE,
  }: {
    projectId: string
    isRoot: boolean
    name: string
    expiresAt?: number | null
    defaultCustomerId?: string | null
    type?: ApiKeyType
  }): Promise<Result<ApiKey & { key: string }, FetchError>> {
    const apiKey = newApiKeySecret()
    const apiKeyId = newId("apikey")
    const apiKeyHash = await hashStringSHA256(apiKey)

    const { val, err } = await wrapResult(
      this.db
        .insert(apikeys)
        .values({
          id: apiKeyId,
          name,
          hash: apiKeyHash,
          expiresAt,
          projectId,
          isRoot,
          defaultCustomerId,
          type,
        })
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error creating api key: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error creating api key",
        projectId,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "Failed to create API key",
          retry: false,
        })
      )
    }

    this.waitUntil(this.cache.apiKeyByHash.remove(apiKeyHash))

    return Ok({
      ...(val as ApiKey),
      key: apiKey,
    })
  }

  public async rollDefaultSdkExampleApiKey({
    projectId,
    isRoot,
    timezone,
  }: {
    projectId: string
    isRoot: boolean
    timezone?: string
  }): Promise<
    Result<
      ApiKey & { key: string; state: "created" | "rolled" },
      SchemaError | FetchError | UnPriceApiKeyError
    >
  > {
    const expiresAt = endOfCurrentDayMs(timezone)
    return this.createOrRollApiKey({
      projectId,
      isRoot,
      name: SDK_EXAMPLE_API_KEY_NAME,
      expiresAt,
      defaultCustomerId: null,
    })
  }

  public async createOrRollApiKey({
    projectId,
    isRoot,
    name,
    expiresAt,
    defaultCustomerId,
  }: {
    projectId: string
    isRoot: boolean
    name: string
    expiresAt?: number | null
    defaultCustomerId?: string | null
  }): Promise<
    Result<
      ApiKey & { key: string; state: "created" | "rolled" },
      SchemaError | FetchError | UnPriceApiKeyError
    >
  > {
    const { val: existingKey, err: existingKeyErr } = await wrapResult(
      this.db.query.apikeys.findFirst({
        where: (apikey, { and, eq, isNull }) =>
          and(eq(apikey.projectId, projectId), eq(apikey.name, name), isNull(apikey.revokedAt)),
        orderBy: (apikey, { desc }) => [desc(apikey.updatedAtM)],
      }),
      (error) =>
        new FetchError({
          message: `error finding reusable api key: ${error.message}`,
          retry: false,
        })
    )

    if (existingKeyErr) {
      this.logger.error(existingKeyErr, {
        context: "error finding reusable api key",
        projectId,
        apiKeyName: name,
      })
      return Err(existingKeyErr)
    }

    if (!existingKey) {
      const createdKey = await this.createApiKey({
        projectId,
        isRoot,
        name,
        expiresAt,
        defaultCustomerId,
      })

      if (createdKey.err) {
        return Err(createdKey.err)
      }

      return Ok({
        ...createdKey.val,
        state: "created",
      })
    }

    if (
      existingKey.isRoot !== isRoot ||
      (existingKey.defaultCustomerId ?? null) !== (defaultCustomerId ?? null)
    ) {
      return Err(
        new FetchError({
          message: "Reusable API key binding does not match the requested binding",
          retry: false,
        })
      )
    }

    const rolledKey = await this.rollApiKey({
      keyHash: existingKey.hash,
      projectId,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    })

    if (rolledKey.err) {
      return Err(rolledKey.err)
    }

    return Ok({
      ...rolledKey.val,
      key: rolledKey.val.newKey,
      state: "rolled",
    })
  }

  public async revokeApiKeys({
    projectId,
    ids,
  }: {
    projectId: string
    ids: string[]
  }): Promise<Result<{ state: "not_found" } | { state: "ok"; numRevoked: number }, FetchError>> {
    const { val, err } = await wrapResult(
      this.db
        .update(apikeys)
        .set({ revokedAt: Date.now(), updatedAtM: Date.now() })
        .where(
          and(inArray(apikeys.id, ids), eq(apikeys.projectId, projectId), isNull(apikeys.revokedAt))
        )
        .returning(),
      (error) =>
        new FetchError({
          message: `error revoking api keys: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error revoking api keys",
        projectId,
      })
      return Err(err)
    }

    if (val.length === 0) {
      return Ok({
        state: "not_found",
      })
    }

    this.waitUntil(Promise.all(val.map((apikey) => this.cache.apiKeyByHash.remove(apikey.hash))))

    return Ok({
      state: "ok",
      numRevoked: val.length,
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

  private async getData(keyHash: string, projectId?: string): Promise<ApiKeyExtended | null> {
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
                  slug: true,
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
          defaultCustomerId: true,
          type: true,
        },
        where: (apikey, { and, eq }) =>
          projectId
            ? and(eq(apikey.hash, keyHash), eq(apikey.projectId, projectId))
            : eq(apikey.hash, keyHash),
      })
      .catch((e) => {
        this.logger.set({ error: toErrorContext(e) })
        this.logger.error(e, {
          context: `Error fetching apikey from db: ${e.message}`,
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
    // ApiKeyCache, not ApiKeyExtended: a cache hit may predate the `type` column.
  ): Promise<Result<ApiKeyCache, SchemaError | FetchError | UnPriceApiKeyError>> {
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
  }): Promise<Result<ApiKeyCache, UnPriceApiKeyError | FetchError | SchemaError>> {
    try {
      const { key } = req
      let retriedWithoutCache = false

      const result = await this.getApiKey(
        {
          key,
        },
        {
          skipCache: false,
        }
      ).catch(async (err) => {
        this.logger.error(err, {
          context: `verify error, retrying without cache, ${err.message}`,
        })

        retriedWithoutCache = true
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
        this.logger.error(result.err, {
          context: retriedWithoutCache
            ? "Error verifying apikey after retrying without cache"
            : "Error verifying apikey",
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
      this.logger.error(error, {
        context: "Unhandled error while getting the apikey",
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
    projectId: string
    expiresAt?: number | null
  }): Promise<Result<ApiKey & { newKey: string }, SchemaError | FetchError | UnPriceApiKeyError>> {
    const apiKey = await this.getData(req.keyHash, req.projectId)

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

    const newKey = newApiKeySecret()
    // generate hash of the key
    const apiKeyHash = await hashStringSHA256(newKey)
    const updates: { updatedAtM: number; hash: string; expiresAt?: number | null } = {
      updatedAtM: Date.now(),
      hash: apiKeyHash,
    }

    if ("expiresAt" in req) {
      updates.expiresAt = req.expiresAt
    }

    const newApiKey = await this.db
      .update(apikeys)
      .set(updates)
      .where(and(eq(apikeys.id, apiKey.id), eq(apikeys.projectId, req.projectId)))
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

    // evict stale entry under old hash, then cache under new hash
    this.waitUntil(
      this.cache.apiKeyByHash.remove(req.keyHash).then(() =>
        this.cache.apiKeyByHash.set(apiKeyHash, {
          ...apiKey,
          ...newApiKey,
        })
      )
    )

    return Ok(newApiKeyExtended)
  }

  public async bindCustomer({
    apikeyId,
    customerId,
    projectId,
  }: {
    apikeyId: string
    customerId: string
    projectId: string
  }): Promise<Result<{ state: "ok" } | { state: "not_found" }, FetchError>> {
    const { val, err } = await wrapResult(
      this.db
        .update(apikeys)
        .set({
          defaultCustomerId: customerId,
          updatedAtM: Date.now(),
        })
        .where(and(eq(apikeys.id, apikeyId), eq(apikeys.projectId, projectId)))
        .returning({
          hash: apikeys.hash,
        }),
      (error) =>
        new FetchError({
          message: `error binding customer to api key: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error binding customer to api key",
        projectId,
        apikeyId,
        customerId,
      })
      return Err(err)
    }

    if (val.length === 0) {
      return Ok({
        state: "not_found",
      })
    }

    this.waitUntil(Promise.all(val.map((apikey) => this.cache.apiKeyByHash.remove(apikey.hash))))

    return Ok({
      state: "ok",
    })
  }

  public async unbindCustomer({
    apikeyId,
    projectId,
  }: {
    apikeyId: string
    projectId: string
  }): Promise<Result<{ state: "ok" } | { state: "not_found" }, FetchError>> {
    const { val, err } = await wrapResult(
      this.db
        .update(apikeys)
        .set({
          defaultCustomerId: null,
          updatedAtM: Date.now(),
        })
        .where(and(eq(apikeys.id, apikeyId), eq(apikeys.projectId, projectId)))
        .returning({
          hash: apikeys.hash,
        }),
      (error) =>
        new FetchError({
          message: `error unbinding customer from api key: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error unbinding customer from api key",
        projectId,
        apikeyId,
      })
      return Err(err)
    }

    if (val.length === 0) {
      return Ok({
        state: "not_found",
      })
    }

    this.waitUntil(Promise.all(val.map((apikey) => this.cache.apiKeyByHash.remove(apikey.hash))))

    return Ok({
      state: "ok",
    })
  }

  public async resolveCustomerId(req: {
    key: string
  }): Promise<Result<string | null, SchemaError | FetchError | UnPriceApiKeyError>> {
    const { val, err } = await this.getApiKey(
      {
        key: req.key,
      },
      {
        skipCache: false,
      }
    )

    if (err) {
      return Err(err)
    }

    return Ok(val.defaultCustomerId ?? null)
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
