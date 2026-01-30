import type { Analytics } from "@unprice/analytics"
import { hashStringSHA256, newId } from "@unprice/db/utils"
import type { ApiKey, ApiKeyExtended } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, type SchemaError, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import type { Cache } from "@unprice/services/cache"
import type { Metrics } from "@unprice/services/metrics"

import type { Database } from "@unprice/db"
import { and, eq } from "@unprice/db"
import { apikeys } from "@unprice/db/schema"
import { retry } from "../utils/retry"
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

  private async hash(key: string): Promise<string> {
    const cached = this.hashCache.get(key)
    if (cached) {
      return cached
    }
    const hash = await hashStringSHA256(key)
    // we don't want to use swr here as it doesn't make sense to do a network call to the cache if there is miss
    // only improve a little bit of latency when hitting the same isolate in cloudflare
    this.hashCache.set(key, hash)
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
        this.logger.error(`Error fetching apikey from db: ${e.message}`, {
          error: e,
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

    const { val: data, err } = opts?.skipCache
      ? await wrapResult(
          this.getData(keyHash),
          (err) =>
            new FetchError({
              message: `unable to query db, ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                method: "",
                keyHash,
              },
            })
        )
      : await retry(
          3,
          async () => this.cache.apiKeyByHash.swr(keyHash, (h) => this.getData(h)),
          (attempt, err) => {
            this.logger.warn("Failed to fetch key data, retrying... getApiKey", {
              hash: keyHash,
              attempt,
              error: err.message,
            })
          }
        )

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
          error: err.message,
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
          error: {
            type: result.err.name,
            message: result.err.message,
            stack: result.err.stack,
          },
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
        error: JSON.stringify(error),
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

  public async rateLimit(req: {
    limiter: ApiKeyLimiter
    key: string
    workspaceId: string
    source: string
  }) {
    // hash the key
    const keyHash = await this.hash(req.key)
    const start = performance.now()
    const result = await req.limiter.limit({ key: keyHash })
    const end = performance.now()
    const workspaceId = req.workspaceId

    if (result.success) {
      // emit metrics
      this.waitUntil(
        Promise.all([
          this.metrics.emit({
            metric: "metric.ratelimit",
            workspaceId,
            identifier: keyHash,
            latency: end - start,
            mode: req.source,
            success: result.success,
            error: !result.success,
            source: req.source,
          }),
        ])
      )
    }

    return result.success
  }
}
