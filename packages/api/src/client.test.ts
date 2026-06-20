import { describe, expect, expectTypeOf, it } from "vitest"
import { Unprice } from "./client"
import type { OperationInput } from "./operation-types"

const createJsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    status: init?.status ?? 200,
  })

const createClient = (fetch?: (input: Request) => Promise<Response>) =>
  new Unprice({
    token: "test-token",
    baseUrl: "https://example.com",
    disableTelemetry: true,
    retry: { attempts: 0 },
    ...(fetch ? { fetch } : {}),
  })

describe("Unprice client", () => {
  it("keeps generated analytics SDK contracts aligned with OpenAPI operation shapes", () => {
    const client = createClient()

    expectTypeOf(client.analytics.charges.explain)
      .parameter(0)
      .toEqualTypeOf<OperationInput<"analytics.charges.explain">>()
    expectTypeOf(client.analytics.usage.forecast)
      .parameter(0)
      .toEqualTypeOf<OperationInput<"analytics.usage.forecast">>()
    expectTypeOf(client.analytics.usage.get)
      .parameter(0)
      .toEqualTypeOf<OperationInput<"analytics.usage.get">>()
    expectTypeOf(client.ingestionEvents.status)
      .parameter(0)
      .toEqualTypeOf<OperationInput<"ingestionEvents.status">>()
    expectTypeOf<{
      invoice_id: string
      entry_id: string
      limit: number
      offset: number
    }>().toMatchTypeOf<OperationInput<"analytics.charges.explain">>()
    expectTypeOf<{
      customer_id: string
      feature_slug: string
      horizon_days: number
    }>().toMatchTypeOf<OperationInput<"analytics.usage.forecast">>()
  })

  it("exposes generated resource clients for every public SDK operation", () => {
    const client = createClient()
    const clientRecord = client as unknown as Record<string, unknown>

    expect(typeof client.access.update).toBe("function")
    expect(typeof client.access.check).toBe("function")
    expect(typeof client.access.entitlements.list).toBe("function")
    expect(typeof client.usage.record).toBe("function")
    expect(typeof client.usage.consume).toBe("function")
    expect(typeof client.runs.start).toBe("function")
    expect(typeof client.runs.consume).toBe("function")
    expect(typeof client.runs.end).toBe("function")
    expect(typeof client.runs.get).toBe("function")
    expect(typeof client.customers.signUp).toBe("function")
    expect(typeof client.features.list).toBe("function")
    expect(typeof client.planVersions.get).toBe("function")
    expect(typeof client.planVersions.list).toBe("function")
    expect(typeof client.paymentMethods.create).toBe("function")
    expect(typeof client.paymentMethods.list).toBe("function")
    expect(typeof client.analytics.charges.explain).toBe("function")
    expect(typeof client.analytics.usage.forecast).toBe("function")
    expect(typeof client.analytics.usage.get).toBe("function")
    expect(typeof client.ingestionEvents.status).toBe("function")
    expect(typeof client.ingestionEvents.replay).toBe("function")
    expect(typeof client.subscriptions.get).toBe("function")
    expect(typeof client.wallet.balance).toBe("function")
    expect(typeof client.walletCredits.balance).toBe("function")
    expect(typeof client.invoices.get).toBe("function")

    expect("entitlements" in clientRecord).toBe(false)
    expect("events" in clientRecord).toBe(false)
    expect("plans" in clientRecord).toBe(false)
    expect("payments" in clientRecord).toBe(false)
    expect("billing" in clientRecord).toBe(false)
    expect("agents" in clientRecord).toBe(false)
  })

  it("uses openapi-fetch path params, query params, body, and auth headers", async () => {
    const requests: Request[] = []
    const client = createClient(async (request) => {
      requests.push(request.clone())
      return createJsonResponse({
        invoice: {
          id: "inv_123",
          project_id: "prj_123",
          subscription_id: "sub_123",
          customer_id: "cus_123",
          status: "paid",
          currency: "USD",
          statement_key: "statement_123",
          statement_start_at: 1,
          statement_end_at: 2,
          due_at: 2,
          past_due_at: 3,
          issue_date: 1,
          sent_at: 1,
          paid_at: 2,
          gross_amount: 100,
          amount_due: 75,
          amount_paid: 15,
          amount_included: 10,
        },
        lines: [],
      })
    })

    const { result, error } = await client.invoices.get({ invoiceId: "inv_123" })

    expect(error).toBeUndefined()
    expect(result?.invoice.id).toBe("inv_123")
    expect(result?.invoice.gross_amount).toBe(100)
    expect(result?.invoice.amount_due).toBe(75)
    expect(result?.invoice.amount_paid).toBe(15)
    expect(result?.invoice.amount_included).toBe(10)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe("GET")
    expect(requests[0]?.url).toBe("https://example.com/v1/invoices/get/inv_123")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-token")
    expect(requests[0]?.headers.get("unprice-request-source")).toMatch(/^sdk@/)
  })

  it("serializes wallet credit balance paths and query params", async () => {
    const requests: Request[] = []
    const amount = {
      ledger_amount: 10,
      amount: "0.00000010",
      currency: "USD",
      display_amount: "$0.00000010",
    }
    const client = createClient(async (request) => {
      requests.push(request.clone())
      return createJsonResponse({
        currency: "USD",
        wallet: {
          id: "wcr_123",
          source: "credit_line",
          issued: amount,
          available: amount,
          expires_at: null,
          created_at: "2026-05-07T12:28:35.906Z",
        },
      })
    })

    const { result, error } = await client.walletCredits.balance({
      customerId: "cus_123",
      projectId: "prj_123",
      walletId: "wcr_123",
    })

    expect(error).toBeUndefined()
    expect(result?.wallet.id).toBe("wcr_123")
    expect(requests[0]?.method).toBe("GET")
    expect(requests[0]?.url).toBe(
      "https://example.com/v1/wallet-credits/balance/wcr_123?customerId=cus_123&projectId=prj_123"
    )
  })

  it("sends generated POST operation bodies through the typed OpenAPI transport", async () => {
    const requests: Request[] = []
    const client = createClient(async (request) => {
      requests.push(request.clone())
      return createJsonResponse({
        allowed: true,
        state: "processed",
      })
    })

    const { result, error } = await client.usage.consume({
      customerId: "cus_123",
      eventSlug: "tokens_used",
      featureSlug: "tokens",
      idempotencyKey: "idem_123",
      properties: {
        amount: 42,
      },
    })

    expect(error).toBeUndefined()
    expect(result?.allowed).toBe(true)
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe("https://example.com/v1/usage/consume")
    await expect(requests[0]?.json()).resolves.toEqual({
      customerId: "cus_123",
      eventSlug: "tokens_used",
      featureSlug: "tokens",
      idempotencyKey: "idem_123",
      properties: {
        amount: 42,
      },
    })
  })

  it("calls replay failed ingestion endpoint", async () => {
    const requests: Request[] = []
    const client = createClient(async (request) => {
      requests.push(request.clone())
      return createJsonResponse({
        replayed: 1,
        skipped: 0,
      })
    })

    const { result, error } = await client.ingestionEvents.replay({
      canonical_audit_ids: ["audit_1"],
      project_id: "proj_123",
    })

    expect(error).toBeUndefined()
    expect(result).toEqual({ replayed: 1, skipped: 0 })
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe("https://example.com/v1/ingestion-events/replay")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-token")
    await expect(requests[0]?.json()).resolves.toEqual({
      canonical_audit_ids: ["audit_1"],
      project_id: "proj_123",
    })
  })

  it("maps API error payloads to the SDK result shape", async () => {
    const client = createClient(async () =>
      createJsonResponse(
        {
          error: {
            code: "NOT_FOUND",
            message: "Invoice not found",
            docs: "https://docs.unprice.dev/api-reference/errors/code/NOT_FOUND",
            requestId: "req_123",
          },
        },
        { status: 404 }
      )
    )

    const { result, error } = await client.invoices.get({ invoiceId: "inv_missing" })

    expect(result).toBeUndefined()
    expect(error).toMatchObject({
      code: "NOT_FOUND",
      message: "Invoice not found",
      requestId: "req_123",
    })
  })

  it("retries server errors inside the OpenAPI transport", async () => {
    let calls = 0
    const client = new Unprice({
      token: "test-token",
      baseUrl: "https://example.com",
      disableTelemetry: true,
      retry: {
        attempts: 1,
        backoff: () => 0,
      },
      fetch: async () => {
        calls += 1
        if (calls === 1) {
          return createJsonResponse(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "temporary failure",
                docs: "https://docs.unprice.dev/api-reference/errors/code/INTERNAL_SERVER_ERROR",
                requestId: "req_123",
              },
            },
            { status: 500 }
          )
        }

        return createJsonResponse(
          {
            accepted: true,
          },
          { status: 202 }
        )
      },
    })

    const { result, error } = await client.usage.record({
      idempotencyKey: "idem_123",
      eventSlug: "tokens",
      customerId: "cus_123",
      properties: {},
    })

    expect(error).toBeUndefined()
    expect(result?.accepted).toBe(true)
    expect(calls).toBe(2)
  })
})
