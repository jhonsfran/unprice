import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { type IdempotencyClaimResult, createHttpIdempotencyMiddleware } from "./idempotency"

type StoreEntry = { status: "in_flight" } | { status: "complete"; response: Response }

function createMemoryStore(
  entries: Map<string, StoreEntry>,
  options: {
    onRelease?: (key: string) => Promise<void>
    onSave?: (key: string, response: Response) => Promise<void>
  } = {}
) {
  return {
    getKey: (c) => c.req.header("idempotency-key") ?? null,
    claim: async (key): Promise<IdempotencyClaimResult> => {
      const entry = entries.get(key)

      if (!entry) {
        entries.set(key, { status: "in_flight" })
        return { status: "claimed" }
      }

      if (entry.status === "complete") {
        return { status: "replayed", response: entry.response.clone() }
      }

      return { status: "in_flight" }
    },
    save: async (key, response) => {
      await options.onSave?.(key, response.clone())
      entries.set(key, { status: "complete", response: response.clone() })
    },
    release: async (key) => {
      entries.delete(key)
      await options.onRelease?.(key)
    },
  } satisfies Parameters<typeof createHttpIdempotencyMiddleware>[0]
}

describe("createHttpIdempotencyMiddleware", () => {
  it("retains successful responses for replay", async () => {
    const app = new Hono()
    const store = new Map<string, StoreEntry>()
    const savedBodies = new Map<string, unknown>()
    let calls = 0
    app.use(
      "*",
      createHttpIdempotencyMiddleware(
        createMemoryStore(store, {
          onSave: async (key, response) => {
            savedBodies.set(key, await response.json())
          },
        })
      )
    )
    app.post("/mutate", () => {
      calls += 1
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          "x-mutated": "true",
        },
      })
    })

    const first = await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_1" },
    })
    const second = await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_1" },
    })

    expect(first.status).toBe(201)
    expect(first.headers.get("x-mutated")).toBe("true")
    expect(await first.json()).toEqual({ ok: true })
    expect(savedBodies.get("idem_1")).toEqual({ ok: true })
    expect(second.status).toBe(201)
    expect(second.headers.get("x-mutated")).toBe("true")
    expect(await second.json()).toEqual({ ok: true })
    expect(calls).toBe(1)
  })

  it("releases keys for 5xx responses", async () => {
    const app = new Hono()
    const store = new Map<string, StoreEntry>()
    let calls = 0
    app.use("*", createHttpIdempotencyMiddleware(createMemoryStore(store)))
    app.post("/mutate", () => {
      calls += 1
      return new Response("failed", { status: 500 })
    })

    await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_500" },
    })
    await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_500" },
    })

    expect(calls).toBe(2)
    expect(store.has("idem_500")).toBe(false)
  })

  it("returns the original 5xx response when release cleanup fails", async () => {
    const app = new Hono()
    const store = new Map<string, StoreEntry>()
    app.use(
      "*",
      createHttpIdempotencyMiddleware(
        createMemoryStore(store, {
          onRelease: async () => {
            throw new Error("release failed")
          },
        })
      )
    )
    app.post("/mutate", () => new Response("failed", { status: 503 }))

    const response = await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_release_500" },
    })

    expect(response.status).toBe(503)
    expect(await response.text()).toBe("failed")
  })

  it("releases claimed keys when saving a response fails", async () => {
    const app = new Hono()
    const store = new Map<string, StoreEntry>()
    const releases: string[] = []
    let calls = 0
    app.use(
      "*",
      createHttpIdempotencyMiddleware(
        createMemoryStore(store, {
          onRelease: async (key) => {
            releases.push(key)
          },
          onSave: async () => {
            throw new Error("save failed")
          },
        })
      )
    )
    app.onError((error) => new Response(error.message, { status: 500 }))
    app.post("/mutate", (c) => {
      calls += 1
      return c.json({ ok: true }, 200)
    })

    const first = await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_save" },
    })
    const second = await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_save" },
    })

    expect(first.status).toBe(500)
    expect(await first.text()).toBe("save failed")
    expect(second.status).toBe(500)
    expect(calls).toBe(2)
    expect(releases).toEqual(["idem_save", "idem_save"])
    expect(store.has("idem_save")).toBe(false)
  })

  it("does not run the handler for in-flight duplicate requests", async () => {
    const app = new Hono()
    const store = new Map<string, StoreEntry>()
    let calls = 0
    let markEntered!: () => void
    let releaseHandler!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      releaseHandler = resolve
    })

    app.use("*", createHttpIdempotencyMiddleware(createMemoryStore(store)))
    app.post("/mutate", async (c) => {
      calls += 1
      markEntered()
      await blocked
      return c.json({ ok: true }, 200)
    })

    const first = app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_inflight" },
    })
    await entered
    const second = await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_inflight" },
    })

    expect(calls).toBe(1)
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({
      code: "IDEMPOTENCY_IN_FLIGHT",
      message: "Request already in progress",
    })

    releaseHandler()
    expect((await first).status).toBe(200)
  })

  it("releases keys when the handler throws", async () => {
    const app = new Hono()
    const store = new Map<string, StoreEntry>()
    let calls = 0
    app.use("*", createHttpIdempotencyMiddleware(createMemoryStore(store)))
    app.onError(() => new Response("failed", { status: 500 }))
    app.post("/mutate", () => {
      calls += 1
      throw new Error("failed")
    })

    await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_throw" },
    })
    await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_throw" },
    })

    expect(calls).toBe(2)
    expect(store.has("idem_throw")).toBe(false)
  })

  it("keeps the handler error when release cleanup fails after a throw", async () => {
    const app = new Hono()
    const store = new Map<string, StoreEntry>()
    app.use(
      "*",
      createHttpIdempotencyMiddleware(
        createMemoryStore(store, {
          onRelease: async () => {
            throw new Error("release failed")
          },
        })
      )
    )
    app.onError((error) => new Response(error.message, { status: 500 }))
    app.post("/mutate", () => {
      throw new Error("handler failed")
    })

    const response = await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_throw_release" },
    })

    expect(response.status).toBe(500)
    expect(await response.text()).toBe("handler failed")
  })
})
