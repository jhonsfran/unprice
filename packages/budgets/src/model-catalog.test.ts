import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Unprice } from "./client"

const row = {
  id: "openai/gpt-5",
  provider: "openai",
  model: "gpt-5",
  unit: "money:USD",
  per: 1_000_000,
  rates: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  tiers: [],
  limits: { context: 400_000, output: 128_000 },
}

function fixture(options: { fail?: boolean } = {}) {
  const requests: Request[] = []
  const unprice = new Unprice({
    token: "test",
    baseUrl: "https://budgets.test",
    disableTelemetry: true,
    retry: { attempts: 0 },
    fetch: async (request) => {
      requests.push(request)
      if (options.fail) throw new TypeError("connection refused")
      const ids = new URL(request.url).searchParams.get("ids")?.split(",") ?? []
      return Response.json({ version: "2026-10-20", models: ids.includes(row.id) ? [row] : [] })
    },
  })
  return { unprice, requests }
}

describe("unprice.model", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse("2026-10-20T12:00:00.000Z"))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("fetches a model's rates once and answers later calls from memory", async () => {
    const { unprice, requests } = fixture()
    expect(await unprice.model("openai/gpt-5")).toEqual({ result: row })
    expect(await unprice.model("openai/gpt-5")).toEqual({ result: row })
    expect(requests).toHaveLength(1)
    const request = requests[0]
    if (!request) throw new Error("no request")
    expect(request.method).toBe("GET")
    const url = new URL(request.url)
    expect(url.pathname).toBe("/v1/budgets/models")
    expect(url.searchParams.get("ids")).toBe("openai/gpt-5")
  })

  it("coalesces concurrent calls for one model into one request", async () => {
    const { unprice, requests } = fixture()
    const results = await Promise.all([
      unprice.model("openai/gpt-5"),
      unprice.model("openai/gpt-5"),
      unprice.model("openai/gpt-5"),
    ])
    expect(results).toEqual([{ result: row }, { result: row }, { result: row }])
    expect(requests).toHaveLength(1)
  })

  it("asks again once the cached row is an hour old", async () => {
    const { unprice, requests } = fixture()
    await unprice.model("openai/gpt-5")
    vi.setSystemTime(Date.parse("2026-10-20T12:59:59.000Z"))
    await unprice.model("openai/gpt-5")
    expect(requests).toHaveLength(1)
    vi.setSystemTime(Date.parse("2026-10-20T13:00:00.000Z"))
    await unprice.model("openai/gpt-5")
    expect(requests).toHaveLength(2)
  })

  it("answers NOT_FOUND for a model the catalog does not know, and remembers the miss", async () => {
    const { unprice, requests } = fixture()
    const missing = await unprice.model("openai/gpt-unknown")
    expect(missing.result).toBeUndefined()
    expect(missing.error).toMatchObject({ code: "NOT_FOUND" })
    expect(missing.error?.message).toContain("openai/gpt-unknown")
    await unprice.model("openai/gpt-unknown")
    expect(requests).toHaveLength(1)
  })

  it("does not cache a transport failure", async () => {
    const { unprice, requests } = fixture({ fail: true })
    expect((await unprice.model("openai/gpt-5")).error).toMatchObject({ code: "FETCH_ERROR" })
    expect((await unprice.model("openai/gpt-5")).error).toMatchObject({ code: "FETCH_ERROR" })
    expect(requests).toHaveLength(2)
  })

  it("rejects an id without a provider segment before any request", async () => {
    const { unprice, requests } = fixture()
    await expect(unprice.model("gpt-5")).rejects.toThrow("provider/model")
    expect(requests).toHaveLength(0)
  })
})
