import { FetchError } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { HttpBillingReservationFlushGateway } from "./reservation-flush-gateway"

const input = {
  customerId: "cus_123",
  subscriptionId: "sub_123",
  subscriptionPhaseId: "phase_123",
  statementKey: "statement_123",
}

describe("HttpBillingReservationFlushGateway", () => {
  it("posts billing reservation flushes to the internal API with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    const gateway = new HttpBillingReservationFlushGateway({
      baseUrl: "https://api.example.test/",
      token: "secret_token",
      fetch: fetchMock,
    })

    const result = await gateway.flushForInvoicing(input)

    expect(result.err).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()

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
})
