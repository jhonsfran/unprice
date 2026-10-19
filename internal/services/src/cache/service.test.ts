import type { Store } from "@unkey/cache/stores"
import { MemoryStore } from "@unkey/cache/stores"
import { describe, expect, it } from "vitest"
import type { Metrics } from "../metrics"
import type { CacheNamespace, CacheNamespaces } from "./namespaces"
import { CacheService } from "./service"

type AnyStore = Store<CacheNamespace, CacheNamespaces[CacheNamespace]>

function countingStore(inner: AnyStore) {
  const counts = { reads: 0 }
  const store: AnyStore = {
    name: "lower",
    get: (namespace, key) => {
      counts.reads += 1
      return inner.get(namespace, key)
    },
    set: (namespace, key, entry) => inner.set(namespace, key, entry),
    remove: (namespace, keys) => inner.remove(namespace, keys),
  }
  return { store, counts }
}

describe("CacheService", () => {
  it("keeps a value found in a lower tier in memory for the next read", async () => {
    const key = `backfill-${crypto.randomUUID()}`
    const value = { id: "key_1" } as unknown as CacheNamespaces["apiKeyByHash"]
    const lower = new MemoryStore<CacheNamespace, CacheNamespaces[CacheNamespace]>({
      persistentMap: new Map(),
    })
    const now = Date.now()
    await lower.set("apiKeyByHash", key, {
      value,
      freshUntil: now + 60_000,
      staleUntil: now + 3_600_000,
    })
    const { store, counts } = countingStore(lower)
    const pending: Promise<unknown>[] = []
    const service = new CacheService(
      { waitUntil: (promise) => void pending.push(promise) },
      {} as Metrics,
      false
    )
    service.init([store])
    const cache = service.getCache()

    const first = await cache.apiKeyByHash.get(key)
    await Promise.all(pending)
    const second = await cache.apiKeyByHash.get(key)

    expect(first.val).toEqual({ id: "key_1" })
    expect(second.val).toEqual({ id: "key_1" })
    expect(counts.reads).toBe(1)
  })
})
