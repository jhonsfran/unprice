import type { Database } from "@unprice/db"
import { Err, FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache"
import type { Metrics } from "../metrics"
import { ApiKeysService } from "./service"

describe("ApiKeysService customer binding", () => {
  const cache = {
    apiKeyByHash: {
      remove: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      swr: vi.fn(),
    },
  } as unknown as Cache
  const metrics = {
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as Metrics
  const logger = {
    set: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
  const analytics = {} as never
  const hashCache = new Map<string, string>()
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("bindCustomer updates defaultCustomerId and invalidates api key hash cache", async () => {
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ hash: "hash_123" }]),
          }),
        }),
      }),
    } as unknown as Database

    const service = new ApiKeysService({
      cache,
      metrics,
      analytics,
      logger,
      db,
      waitUntil,
      hashCache,
    })

    const result = await service.bindCustomer({
      apikeyId: "api_123",
      customerId: "cus_123",
      projectId: "proj_123",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({ state: "ok" })
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  it("unbindCustomer clears defaultCustomerId and invalidates cache", async () => {
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ hash: "hash_123" }]),
          }),
        }),
      }),
    } as unknown as Database

    const service = new ApiKeysService({
      cache,
      metrics,
      analytics,
      logger,
      db,
      waitUntil,
      hashCache,
    })

    const result = await service.unbindCustomer({
      apikeyId: "api_123",
      projectId: "proj_123",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({ state: "ok" })
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  it("returns not_found when bindCustomer does not update any row", async () => {
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as Database

    const service = new ApiKeysService({
      cache,
      metrics,
      analytics,
      logger,
      db,
      waitUntil,
      hashCache,
    })

    const result = await service.bindCustomer({
      apikeyId: "missing",
      customerId: "cus_123",
      projectId: "proj_123",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({ state: "not_found" })
  })

  it("resolveCustomerId returns bound customer id from getApiKey", async () => {
    const db = {} as Database
    const service = new ApiKeysService({
      cache,
      metrics,
      analytics,
      logger,
      db,
      waitUntil,
      hashCache,
    })

    vi.spyOn(service, "getApiKey").mockResolvedValue(
      Ok({
        defaultCustomerId: "cus_123",
      } as never)
    )

    const result = await service.resolveCustomerId({
      key: "unprice_live_123",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toBe("cus_123")
  })

  it("resolveCustomerId returns null when key has no default customer", async () => {
    const db = {} as Database
    const service = new ApiKeysService({
      cache,
      metrics,
      analytics,
      logger,
      db,
      waitUntil,
      hashCache,
    })

    vi.spyOn(service, "getApiKey").mockResolvedValue(
      Ok({
        defaultCustomerId: null,
      } as never)
    )

    const result = await service.resolveCustomerId({
      key: "unprice_live_123",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toBeNull()
  })

  it("returns not_found when unbindCustomer targets a non-existent apikey", async () => {
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as Database

    const service = new ApiKeysService({
      cache,
      metrics,
      analytics,
      logger,
      db,
      waitUntil,
      hashCache,
    })

    const result = await service.unbindCustomer({
      apikeyId: "missing",
      projectId: "proj_123",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({ state: "not_found" })
    expect(waitUntil).not.toHaveBeenCalled()
  })

  it("bindCustomer cache invalidation calls remove with the correct hash", async () => {
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ hash: "hash_abc" }]),
          }),
        }),
      }),
    } as unknown as Database

    const service = new ApiKeysService({
      cache,
      metrics,
      analytics,
      logger,
      db,
      waitUntil,
      hashCache,
    })

    await service.bindCustomer({
      apikeyId: "api_123",
      customerId: "cus_123",
      projectId: "proj_123",
    })

    // waitUntil receives a Promise wrapping cache.remove
    expect(waitUntil).toHaveBeenCalledTimes(1)
    // Await the promise passed to waitUntil to trigger the cache remove
    await waitUntil.mock.calls[0]![0]
    expect(cache.apiKeyByHash.remove).toHaveBeenCalledWith("hash_abc")
  })

  it("resolveCustomerId forwards getApiKey errors", async () => {
    const db = {} as Database
    const service = new ApiKeysService({
      cache,
      metrics,
      analytics,
      logger,
      db,
      waitUntil,
      hashCache,
    })

    vi.spyOn(service, "getApiKey").mockResolvedValue(
      Err(
        new FetchError({
          message: "cache miss",
          retry: false,
        })
      )
    )

    const result = await service.resolveCustomerId({
      key: "unprice_live_123",
    })

    expect(result.err).toBeDefined()
    expect(result.err?.message).toBe("cache miss")
  })
})
