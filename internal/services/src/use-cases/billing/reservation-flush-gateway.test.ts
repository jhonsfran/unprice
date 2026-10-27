import { FetchError } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { HttpBillingReservationFlushGateway } from "./reservation-flush-gateway"

const input = {
  projectId: "proj_123",
  customerId: "cus_123",
  subscriptionId: "sub_123",
  subscriptionPhaseId: "phase_123",
  statementKey: "statement_123",
}

describe("HttpBillingReservationFlushGateway", () => {
  it("posts billing reservation flushes to the internal API with bearer auth", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, flushed: 2, skipped: 1, snapshots: [] }))
      )
    const gateway = new HttpBillingReservationFlushGateway({
      baseUrl: "https://api.example.test/",
      token: "secret_token",
      fetch: fetchMock,
    })

    const result = await gateway.flushForInvoicing(input)

    expect(result.err).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.val).toEqual({ flushed: 2, skipped: 1, snapshots: [] })

    const request = fetchMock.mock.calls[0]?.[0]
    expect(request).toBeInstanceOf(Request)
    expect(request?.url).toBe(
      "https://api.example.test/v1/internal/billing-reservations/flush-for-invoicing"
    )
    expect(request?.method).toBe("POST")
    expect(request?.headers.get("authorization")).toBe("Bearer secret_token")
    expect(request?.headers.get("content-type")).toBe("application/json")
    await expect(request?.json()).resolves.toEqual(input)
  })

  it("maps non-2xx responses to FetchError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "flush unavailable" }), {
        status: 503,
      })
    )
    const gateway = new HttpBillingReservationFlushGateway({
      baseUrl: "https://api.example.test",
      token: "secret_token",
      fetch: fetchMock,
    })

    const result = await gateway.flushForInvoicing(input)

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toBe("flush unavailable")
    expect(result.err?.retry).toBe(true)
    expect(result.err?.context).toEqual({
      url: "/v1/internal/billing-reservations/flush-for-invoicing",
      method: "POST",
      status: 503,
    })
  })

  it("treats deferred conflict responses as retryable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "retry later" } }), {
        status: 409,
      })
    )
    const gateway = new HttpBillingReservationFlushGateway({
      baseUrl: "https://api.example.test",
      token: "secret_token",
      fetch: fetchMock,
    })

    const result = await gateway.flushForInvoicing(input)

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toBe("retry later")
    expect(result.err?.retry).toBe(true)
    expect(result.err?.context).toEqual({
      url: "/v1/internal/billing-reservations/flush-for-invoicing",
      method: "POST",
      status: 409,
    })
  })

  it("maps thrown fetch failures to retryable FetchError", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"))
    const gateway = new HttpBillingReservationFlushGateway({
      baseUrl: "https://api.example.test",
      token: "secret_token",
      fetch: fetchMock,
    })

    const result = await gateway.flushForInvoicing(input)

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toBe("network down")
    expect(result.err?.retry).toBe(true)
    expect(result.err?.context).toEqual({
      url: "/v1/internal/billing-reservations/flush-for-invoicing",
      method: "POST",
    })
  })
  it("rejects a flush response that omits snapshot coverage", async () => {
    const gateway = new HttpBillingReservationFlushGateway({
      token: "secret_token",
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ flushed: 1, skipped: 0 }))),
    })

    const result = await gateway.flushForInvoicing(input)

    expect(result.err).toMatchObject({ message: "Invalid internal billing response", retry: true })
  })

  it("keeps completion separate from invoice preparation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ snapshots: [] })))
    const gateway = new HttpBillingReservationFlushGateway({
      token: "secret_token",
      fetch: fetchMock,
    })
    const scope = {
      projectId: input.projectId,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
    }

    const result = await gateway.completeForInvoicing(scope)

    expect(result.err).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const request: Request = fetchMock.mock.calls[0]?.[0]
    expect(new URL(request.url).pathname).toBe("/v1/internal/billing-usage/snapshots")
    await expect(request.json()).resolves.toEqual({ operation: "complete", ...scope })
  })
})
