import { createBasinSql, sqlInteger, sqlString, sqlTimestamp } from "@unprice/lakehouse"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

const rowSchema = z.object({ country: z.string(), visits: z.number() })

const config = {
  accountId: "acc_123",
  bucket: "unprice-lakehouse-dev",
  token: "<BASIN_SQL_TOKEN>",
}

describe("Basin SQL client", () => {
  it("posts the query and parses result.rows", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        result: {
          request_id: "dqe-prod-01",
          schema: [],
          rows: [
            { country: "DE", visits: 12 },
            { country: "US", visits: 3 },
          ],
          metrics: { r2_requests_count: 1, files_scanned: 1, bytes_scanned: 2048, cache_hits: 0 },
        },
        success: true,
        errors: [],
      })
    )
    const basinSql = createBasinSql({ ...config, fetch: fetchMock as unknown as typeof fetch })

    const result = await basinSql.query("SELECT country, visits FROM t LIMIT 2", rowSchema)

    expect(result).toEqual({
      val: [
        { country: "DE", visits: 12 },
        { country: "US", visits: 3 },
      ],
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(
      "https://api.sql.cloudflarestorage.com/api/v1/accounts/acc_123/basin-sql/query/unprice-lakehouse-dev"
    )
    expect(init.headers).toEqual({
      Authorization: "Bearer <BASIN_SQL_TOKEN>",
      "Content-Type": "application/json",
    })
    expect(init.body).toBe('{"query":"SELECT country, visits FROM t LIMIT 2"}')
  })

  it("surfaces the errors array as a QUERY_ERROR", async () => {
    const basinSql = createBasinSql({
      ...config,
      fetch: (async () =>
        Response.json(
          {
            result: null,
            success: false,
            errors: [{ code: 40003, message: "table not found: lakehouse.web_events" }],
          },
          { status: 400 }
        )) as typeof fetch,
    })

    const result = await basinSql.query("SELECT 1", rowSchema)

    expect(result.err?.code).toBe("QUERY_ERROR")
    expect(result.err?.message).toBe(
      "Basin SQL query failed (400): 40003: table not found: lakehouse.web_events"
    )
  })

  it("returns INVALID_RESPONSE when rows do not match the schema", async () => {
    const basinSql = createBasinSql({
      ...config,
      fetch: (async () =>
        Response.json({
          result: { rows: [{ country: "DE", visits: "many" }] },
          success: true,
          errors: [],
        })) as typeof fetch,
    })

    const result = await basinSql.query("SELECT 1", rowSchema)

    expect(result.err?.code).toBe("INVALID_RESPONSE")
  })

  it("times out a query that does not answer, and retries it", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        })
    )
    const basinSql = createBasinSql({
      ...config,
      timeoutMs: 20,
      retries: 1,
      backoffMs: 0,
      fetch: fetchMock as unknown as typeof fetch,
    })

    const result = await basinSql.query("SELECT 1", rowSchema)

    expect(result.err?.code).toBe("TIMEOUT")
    expect(result.err?.message).toBe("Basin SQL query timed out after 20ms")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("classifies a timeout while reading the body as a retryable TIMEOUT", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason))
            },
          })
        )
    )
    const basinSql = createBasinSql({
      ...config,
      timeoutMs: 20,
      retries: 0,
      fetch: fetchMock as unknown as typeof fetch,
    })

    const result = await basinSql.query("SELECT 1", rowSchema)

    expect(result.err?.code).toBe("TIMEOUT")
    expect(result.err?.retry).toBe(true)
  })

  it("retries a 5xx that is not a Basin envelope, then answers the rows", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }))
      .mockResolvedValueOnce(Response.json({ error: "upstream" }, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ result: { rows: [{ country: "DE", visits: 1 }] }, success: true })
      )
    const basinSql = createBasinSql({
      ...config,
      backoffMs: 0,
      fetch: fetchMock as unknown as typeof fetch,
    })

    const result = await basinSql.query("SELECT 1", rowSchema)

    expect(result).toEqual({ val: [{ country: "DE", visits: 1 }] })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("does not retry a query error", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        { result: null, success: false, errors: [{ code: 40003, message: "bad" }] },
        { status: 400 }
      )
    )
    const basinSql = createBasinSql({
      ...config,
      backoffMs: 0,
      fetch: fetchMock as unknown as typeof fetch,
    })

    const result = await basinSql.query("SELECT 1", rowSchema)

    expect(result.err?.retry).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("answers NOT_CONFIGURED without credentials", async () => {
    const result = await createBasinSql({}).query("SELECT 1", rowSchema)

    expect(result.err?.code).toBe("NOT_CONFIGURED")
  })
})

describe("SQL literals", () => {
  it("doubles single quotes so a value cannot close the literal", () => {
    expect(sqlString("x' OR '1'='1")).toBe("'x'' OR ''1''=''1'")
    expect(sqlString("page'; DROP TABLE lakehouse.web_events; --")).toBe(
      "'page''; DROP TABLE lakehouse.web_events; --'"
    )
  })

  it("renders timestamps as RFC 3339 with Z", () => {
    expect(sqlTimestamp(new Date(Date.UTC(2026, 10, 3, 10, 30)))).toBe("'2026-11-03T10:30:00.000Z'")
  })

  it("rejects non-integer limits", () => {
    expect(sqlInteger(50)).toBe("50")
    expect(() => sqlInteger(1.5)).toThrow(RangeError)
  })
})
