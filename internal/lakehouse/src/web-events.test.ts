import {
  type WebEventRow,
  createWebEventsWriter,
  toCloudflarePipelineSchema,
  webEventRowSchema,
} from "@unprice/lakehouse"
import { describe, expect, it, vi } from "vitest"

const pageHit: WebEventRow = {
  schema_version: 1,
  event_id: "8f14e45f-ceea-4e7a-9b1d-2f6a1c0b7d11",
  kind: "page_hit",
  timestamp: "2026-11-03T10:00:00.000Z",
  project_id: "proj_123",
  session_id: "sess_1",
  page_id: "page_1",
  pathname: "/pricing",
  url: "https://acme.unprice.dev/pricing",
  referrer: "(direct)",
  referrer_url: "(direct)",
  locale: "en-US",
  country: "DE",
  region: "BE",
  city: "Berlin",
  continent: "EU",
  device: "desktop",
  device_vendor: "Unknown",
  device_model: "Unknown",
  browser: "Chrome",
  browser_version: "130",
  os: "Mac OS",
  os_version: "15",
  engine: "Blink",
  engine_version: "130",
  cpu_architecture: "Unknown",
  bot: false,
}

const planView: WebEventRow = {
  schema_version: 1,
  event_id: "c4ca4238-a0b9-4382-8dcc-509a6f75849b",
  kind: "plan_view",
  timestamp: "2026-11-03T10:00:00.000Z",
  project_id: "proj_123",
  session_id: "sess_1",
  page_id: "page_1",
  plan_version_id: "pv_1",
}

describe("web events row schema", () => {
  it("accepts a valid page hit", () => {
    expect(webEventRowSchema.safeParse(pageHit)).toEqual({ success: true, data: pageHit })
  })

  it("rejects a row without project_id", () => {
    const { project_id: _omitted, ...withoutProject } = pageHit
    const result = webEventRowSchema.safeParse(withoutProject)

    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["project_id"])
  })

  it("rejects a plan click without plan_version_id", () => {
    const result = webEventRowSchema.safeParse({
      ...planView,
      kind: "plan_click",
      plan_version_id: null,
    })

    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "plan_version_id is required for plan_click rows",
    ])
  })

  it("generates the stream schema with the required columns", () => {
    const fields = toCloudflarePipelineSchema("web_events").fields

    expect(fields.filter((field) => field.required).map((field) => field.name)).toEqual([
      "schema_version",
      "event_id",
      "kind",
      "timestamp",
      "project_id",
      "session_id",
    ])
    expect(fields.find((field) => field.name === "timestamp")).toEqual({
      name: "timestamp",
      type: "timestamp",
      required: true,
    })
  })
})

describe("web events writer", () => {
  it("posts the rows as one JSON array with the stream token", async () => {
    const fetchMock = vi.fn(async () => new Response('{"success":true}', { status: 200 }))
    const writer = createWebEventsWriter({
      url: "https://stream-id.ingest.cloudflare.com",
      token: "<STREAM_TOKEN>",
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(await writer.send([pageHit, planView])).toEqual({ val: { sent: 2 } })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://stream-id.ingest.cloudflare.com")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({
      Authorization: "Bearer <STREAM_TOKEN>",
      "Content-Type": "application/json",
    })
    expect(init.body).toBe(
      '[{"schema_version":1,"event_id":"8f14e45f-ceea-4e7a-9b1d-2f6a1c0b7d11","kind":"page_hit","timestamp":"2026-11-03T10:00:00.000Z","project_id":"proj_123","session_id":"sess_1","page_id":"page_1","pathname":"/pricing","url":"https://acme.unprice.dev/pricing","referrer":"(direct)","referrer_url":"(direct)","locale":"en-US","country":"DE","region":"BE","city":"Berlin","continent":"EU","device":"desktop","device_vendor":"Unknown","device_model":"Unknown","browser":"Chrome","browser_version":"130","os":"Mac OS","os_version":"15","engine":"Blink","engine_version":"130","cpu_architecture":"Unknown","bot":false},{"schema_version":1,"event_id":"c4ca4238-a0b9-4382-8dcc-509a6f75849b","kind":"plan_view","timestamp":"2026-11-03T10:00:00.000Z","project_id":"proj_123","session_id":"sess_1","page_id":"page_1","plan_version_id":"pv_1"}]'
    )
  })

  it("returns an error instead of throwing when the endpoint keeps failing", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }))
    const writer = createWebEventsWriter({
      url: "https://stream-id.ingest.cloudflare.com",
      token: "<STREAM_TOKEN>",
      backoffMs: 0,
      fetch: fetchMock as unknown as typeof fetch,
    })

    const result = await writer.send([pageHit])

    expect(result.err?.code).toBe("HTTP_ERROR")
    expect(result.err?.message).toBe("web events stream returned 503: unavailable")
    expect(result.err?.retry).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("retries a retryable failure with the same rows and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }))
    const writer = createWebEventsWriter({
      url: "https://stream-id.ingest.cloudflare.com",
      token: "<STREAM_TOKEN>",
      backoffMs: 0,
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(await writer.send([pageHit])).toEqual({ val: { sent: 1 } })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const bodies = fetchMock.mock.calls.map((call) => (call[1] as RequestInit).body)
    expect(new Set(bodies).size).toBe(1)
  })

  it("does not retry a rejected batch", async () => {
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }))
    const writer = createWebEventsWriter({
      url: "https://stream-id.ingest.cloudflare.com",
      token: "<STREAM_TOKEN>",
      backoffMs: 0,
      fetch: fetchMock as unknown as typeof fetch,
    })

    const result = await writer.send([pageHit])

    expect(result.err?.retry).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("does not send a batch that holds an invalid row", async () => {
    const fetchMock = vi.fn()
    const writer = createWebEventsWriter({
      url: "https://stream-id.ingest.cloudflare.com",
      token: "<STREAM_TOKEN>",
      fetch: fetchMock as unknown as typeof fetch,
    })

    const result = await writer.send([pageHit, { ...pageHit, project_id: "" }])

    expect(result.err?.code).toBe("INVALID_ROW")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reports NOT_CONFIGURED without a URL or token", async () => {
    const result = await createWebEventsWriter({}).send([pageHit])

    expect(result.err?.code).toBe("NOT_CONFIGURED")
  })
})
