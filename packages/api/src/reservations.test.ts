import { describe, expect, expectTypeOf, it } from "vitest"
import { Unprice } from "./client"
import type { Reservation, ReserveInput, SettleReservationInput } from "./reservations"

const createJsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    status: init?.status ?? 200,
  })

const runSummary = (
  overrides: Partial<{
    status: "running" | "completed" | "expired" | "canceled" | "budget_exceeded" | "failed"
    consumedAmountMinor: number
    remainingAmountMinor: number
  }> = {}
) => ({
  runId: "run_123",
  status: "running" as const,
  customerId: "cus_123",
  currency: "USD",
  workloadType: null,
  workloadId: null,
  traceId: null,
  parentRunId: null,
  budgetAmountMinor: 10,
  consumedAmountMinor: 0,
  remainingAmountMinor: 10,
  ...overrides,
})

const apiErrorResponse = (code: string) =>
  createJsonResponse(
    {
      error: {
        code,
        message: `Request failed: ${code}`,
        docs: `https://docs.unprice.dev/errors/${code}`,
        requestId: "req_123",
      },
    },
    { status: 412 }
  )

const createClient = (responses: Response[]) => {
  const requests: Request[] = []
  const client = new Unprice({
    token: "test-token",
    baseUrl: "https://example.com",
    disableTelemetry: true,
    retry: { attempts: 0 },
    fetch: async (request) => {
      requests.push(request.clone())
      const response = responses.shift()
      if (!response) {
        throw new Error("No queued response")
      }
      return response
    },
  })

  return { client, requests }
}

describe("SDK reservations facade", () => {
  it("reserves a maximum amount and settles accepted usage", async () => {
    const { client, requests } = createClient([
      createJsonResponse(runSummary()),
      createJsonResponse({
        accepted: true,
        reason: "accepted",
        run: runSummary({
          status: "running",
          consumedAmountMinor: 6,
          remainingAmountMinor: 4,
        }),
      }),
      createJsonResponse(
        runSummary({ status: "completed", consumedAmountMinor: 6, remainingAmountMinor: 4 })
      ),
    ])

    const { result: reservation, error } = await client.reservations.reserve({
      customerId: "cus_123",
      maximumAmountMinor: 10,
      idempotencyKey: "message_123",
    })

    expect(error).toBeUndefined()
    expect(reservation).toMatchObject({
      id: "run_123",
      customerId: "cus_123",
      currency: "USD",
      maximumAmountMinor: 10,
    })
    expect(requests[0]?.url).toBe("https://example.com/v1/runs/start")
    await expect(requests[0]?.json()).resolves.toEqual({
      customerId: "cus_123",
      budgetAmountMinor: 10,
      idempotencyKey: "message_123",
    })

    const settlement = await reservation!.settle({
      featureSlug: "ai-tokens",
      eventSlug: "ai-completion",
      properties: { input_tokens: 100, output_tokens: 20 },
    })

    expect(settlement.error).toBeUndefined()
    expect(settlement.result).toMatchObject({
      accepted: true,
      reason: "accepted",
      run: { status: "completed", consumedAmountMinor: 6 },
    })
    expect(requests[1]?.url).toBe("https://example.com/v1/runs/settle/run_123")
    await expect(requests[1]?.json()).resolves.toEqual({
      featureSlug: "ai-tokens",
      eventSlug: "ai-completion",
      idempotencyKey: "message_123:settle",
      properties: { input_tokens: 100, output_tokens: 20 },
    })
    expect(requests[2]?.url).toBe("https://example.com/v1/runs/end/run_123")
    await expect(requests[2]?.json()).resolves.toEqual({ status: "completed" })
    expect(requests).toHaveLength(3)
  })

  it("completes settlement when the usage event is a duplicate", async () => {
    const { client, requests } = createClient([
      createJsonResponse(runSummary()),
      createJsonResponse({
        accepted: false,
        reason: "duplicate",
        run: runSummary({ status: "running" }),
      }),
      createJsonResponse(runSummary({ status: "completed" })),
    ])

    const { result: reservation } = await client.reservations.reserve({
      maximumAmountMinor: 10,
      idempotencyKey: "message_123",
    })
    const settlement = await reservation!.settle({ featureSlug: "ai-tokens" })

    expect(settlement.result?.reason).toBe("duplicate")
    expect(requests).toHaveLength(3)
  })

  it("fails the run and preserves a rejected consumption decision", async () => {
    const { client, requests } = createClient([
      createJsonResponse(runSummary()),
      createJsonResponse({
        accepted: false,
        reason: "insufficient_budget",
        run: runSummary({ status: "running", remainingAmountMinor: 0 }),
      }),
      createJsonResponse(runSummary({ status: "failed", remainingAmountMinor: 0 })),
    ])

    const { result: reservation } = await client.reservations.reserve({
      maximumAmountMinor: 10,
      idempotencyKey: "message_123",
    })
    const settlement = await reservation!.settle({ featureSlug: "ai-tokens" })

    expect(settlement.result).toMatchObject({
      accepted: false,
      reason: "insufficient_budget",
      run: { status: "failed" },
    })
    expect(requests).toHaveLength(3)
  })

  it("releases the full reservation without consuming usage", async () => {
    const { client, requests } = createClient([
      createJsonResponse(runSummary()),
      createJsonResponse(runSummary({ status: "canceled", remainingAmountMinor: 0 })),
    ])

    const { result: reservation } = await client.reservations.reserve({
      maximumAmountMinor: 10,
      idempotencyKey: "message_123",
    })
    const released = await reservation!.release()

    expect(released.result?.status).toBe("canceled")
    expect(requests).toHaveLength(2)
    expect(requests[1]?.url).toBe("https://example.com/v1/runs/end/run_123")
    await expect(requests[1]?.json()).resolves.toEqual({ status: "canceled" })
  })

  it("returns a start error without creating a reservation", async () => {
    const { client, requests } = createClient([apiErrorResponse("INSUFFICIENT_BALANCE")])

    const { result, error } = await client.reservations.reserve({
      maximumAmountMinor: 10,
      idempotencyKey: "message_123",
    })

    expect(result).toBeUndefined()
    expect(error?.code).toBe("INSUFFICIENT_BALANCE")
    expect(requests).toHaveLength(1)
  })

  it("leaves the reservation open when consumption returns an API error", async () => {
    const { client, requests } = createClient([
      createJsonResponse(runSummary()),
      apiErrorResponse("TEMPORARY_FAILURE"),
    ])

    const { result: reservation } = await client.reservations.reserve({
      maximumAmountMinor: 10,
      idempotencyKey: "message_123",
    })
    const settlement = await reservation!.settle({ featureSlug: "ai-tokens" })

    expect(settlement.error?.code).toBe("TEMPORARY_FAILURE")
    expect(requests).toHaveLength(2)
  })

  it("exports the public facade contracts", () => {
    expectTypeOf<{
      customerId: string
      maximumAmountMinor: number
      idempotencyKey: string
    }>().toMatchTypeOf<ReserveInput>()
    expectTypeOf<{
      featureSlug: string
      properties: { tokens: number }
    }>().toMatchTypeOf<SettleReservationInput>()
    expectTypeOf<Reservation["release"]>().returns.resolves.toHaveProperty("result")
  })
})
