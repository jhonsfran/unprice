import { neonConfig } from "@neondatabase/serverless"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HTTP_QUERY_TIMEOUT_MS, createHttpConnection, withFetchTimeout } from "./createConnection"

const url = "postgresql://user:password@ep-example-123456.us-east-2.aws.neon.tech/neondb"

describe("createHttpConnection", () => {
  it("returns null in development, where only the WebSocket proxy runs", () => {
    expect(
      createHttpConnection({ env: "development", primaryDatabaseUrl: url, logger: false })
    ).toBeNull()
  })

  it("reuses the client for the same connection string", () => {
    const a = createHttpConnection({ env: "production", primaryDatabaseUrl: url, logger: false })
    const b = createHttpConnection({ env: "production", primaryDatabaseUrl: url, logger: false })

    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  it("builds the relational api key lookup without opening a connection", () => {
    const db = createHttpConnection({ env: "preview", primaryDatabaseUrl: url, logger: false })
    if (!db) throw new Error("expected an http connection")

    const { sql } = db.query.apikeys
      .findFirst({
        columns: { id: true, projectId: true },
        with: {
          project: {
            columns: { id: true, enabled: true },
            with: { workspace: { columns: { enabled: true } } },
          },
        },
        where: (apikey, { eq }) => eq(apikey.hash, "hash_123"),
      })
      .toSQL()

    expect(sql).toContain("unprice_apikeys")
    expect(sql).toContain("unprice_projects")
    expect(sql).toContain("unprice_workspaces")
  })
})

// A fetch that never resolves on its own and only settles when its signal aborts.
function stalledFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return
      if (signal.aborted) return reject(signal.reason)
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
}

describe("Neon HTTP fetch timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("aborts a stalled fetch once the timeout elapses", async () => {
    const fetchWithTimeout = withFetchTimeout(stalledFetch(), 20)

    await expect(fetchWithTimeout("https://example.com/sql")).rejects.toMatchObject({
      name: "TimeoutError",
    })
  })

  it("still honours a caller supplied abort signal", async () => {
    const fetchWithTimeout = withFetchTimeout(stalledFetch(), 60_000)
    const controller = new AbortController()

    const pending = fetchWithTimeout("https://example.com/sql", { signal: controller.signal })
    controller.abort(new Error("caller aborted"))

    await expect(pending).rejects.toThrow("caller aborted")
  })

  it("installs the timeout once, only for HTTP queries", () => {
    createHttpConnection({ env: "production", primaryDatabaseUrl: url, logger: false })
    const installed = neonConfig.fetchFunction

    createHttpConnection({
      env: "production",
      primaryDatabaseUrl: `${url}?other=1`,
      logger: true,
    })

    expect(typeof installed).toBe("function")
    expect(neonConfig.fetchFunction).toBe(installed)
    expect(neonConfig.poolQueryViaFetch).toBe(false)
  })

  it(
    "aborts a stalled Neon HTTP query instead of hanging",
    async () => {
      const fetchMock = vi.fn(stalledFetch())
      vi.stubGlobal("fetch", fetchMock)

      const db = createHttpConnection({ env: "production", primaryDatabaseUrl: url, logger: false })
      if (!db) throw new Error("expected an http connection")

      const start = Date.now()
      const query = db.query.apikeys.findFirst({ columns: { id: true } })
      const result = await query.then(
        () => "resolved",
        (error: unknown) => error
      )

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const signal = fetchMock.mock.calls[0]?.[1]?.signal
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal?.aborted).toBe(true)
      expect(result).toBeInstanceOf(Error)
      expect(Date.now() - start).toBeGreaterThanOrEqual(HTTP_QUERY_TIMEOUT_MS - 100)
    },
    HTTP_QUERY_TIMEOUT_MS + 5_000
  )
})
