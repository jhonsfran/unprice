import { NoopTinybird, Tinybird } from "@jhonsfran/zod-bird"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

afterEach(() => vi.unstubAllGlobals())

describe("Tinybird Zod v4 integration", () => {
  it("validates pipe parameters and response rows with v4 schemas", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ meta: [], rows: 1, data: [{ count: 7 }] })))
    vi.stubGlobal("fetch", fetch)
    const pipe = new Tinybird({ token: "test", baseUrl: "https://tinybird.test" }).buildPipe({
      pipe: "usage",
      parameters: z.object({ customer: z.string().min(1) }),
      data: z.object({ count: z.number().int() }),
    })

    const result = await pipe({ customer: "customer-1" })
    expect(result.data[0]?.count).toBe(7)
    expect(result.rows).toBe(1)
    expect(fetch.mock.calls[0]?.[0].searchParams.get("customer")).toBe("customer-1")
    await expect(pipe({ customer: "" })).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)

    fetch.mockResolvedValue(new Response(JSON.stringify({ meta: [], data: [{ count: "bad" }] })))
    await expect(pipe({ customer: "customer-1" })).rejects.toThrow()
  })

  it("validates and transforms ingestion events before sending them", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ successful_rows: 1, quarantined_rows: 0 })))
    vi.stubGlobal("fetch", fetch)
    const ingest = new Tinybird({
      token: "test",
      baseUrl: "https://tinybird.test",
    }).buildIngestEndpoint({
      datasource: "events",
      event: z.object({ count: z.string().transform(Number) }),
    })

    expect(await ingest({ count: "7" })).toEqual({ successful_rows: 1, quarantined_rows: 0 })
    expect(fetch.mock.calls[0]?.[1].body).toBe('{"count":7}')
  })

  it("keeps the noop client usable without network access", async () => {
    const pipe = new NoopTinybird().buildPipe({
      pipe: "usage",
      data: z.object({ count: z.number() }),
    })
    expect(await pipe(undefined)).toEqual({ meta: [], data: [] })
  })
})
