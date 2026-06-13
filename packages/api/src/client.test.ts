import { describe, expect, expectTypeOf, it } from "vitest"
import { Unprice } from "./client"
import type { paths } from "./openapi"

const createJsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    status: init?.status ?? 200,
  })

describe("Unprice client", () => {
  it("keeps analytics SDK contracts aligned with route defaults and nullable tier data", () => {
    const client = new Unprice({
      token: "test-token",
      baseUrl: "https://example.com",
      disableTelemetry: true,
      retry: { attempts: 0 },
    })

    expectTypeOf(client.analytics.explainCharge).parameter(0).toMatchTypeOf<{
      invoice_id: string
      entry_id: string
      project_id?: string
      limit?: number
      offset?: number
    }>()
    expectTypeOf<{
      invoice_id: string
      entry_id: string
      limit: number
      offset: number
    }>().toMatchTypeOf<
      paths["/v1/analytics/explain-charge"]["post"]["requestBody"]["content"]["application/json"]
    >()
    expectTypeOf(client.analytics.ingestion.status).parameter(0).toMatchTypeOf<{
      customer_id?: string
      from_ts: number
      to_ts: number
      cursor?: {
        handledAt: number
        canonicalAuditId: string
      } | null
      source_id?: string
      event_slug?: string
      state?: "processed" | "rejected" | "failed"
      limit?: number
    }>()
    expectTypeOf<{
      customer_id: string
      from_ts: number
      to_ts: number
      limit: number
    }>().toMatchTypeOf<
      paths["/v1/analytics/ingestion/status"]["post"]["requestBody"]["content"]["application/json"]
    >()
    expectTypeOf(client.analytics.forecastUsage).parameter(0).toMatchTypeOf<{
      customer_id: string
      feature_slug: string
      period_key?: string
      horizon_days?: number
    }>()
    expectTypeOf<{
      customer_id: string
      feature_slug: string
    }>().toMatchTypeOf<Parameters<typeof client.analytics.forecastUsage>[0]>()
    expectTypeOf<{
      customer_id: string
      feature_slug: string
      horizon_days: number
    }>().toMatchTypeOf<
      paths["/v1/analytics/forecast-usage"]["post"]["requestBody"]["content"]["application/json"]
    >()
    expectTypeOf<ExplainChargeEventRow["tier_mode"]>().toEqualTypeOf<unknown>()
  })

  it("exposes resource clients for every public API route", () => {
    const client = new Unprice({
      token: "test-token",
      baseUrl: "https://example.com",
      disableTelemetry: true,
      retry: { attempts: 0 },
    })

    expect(typeof client.access.update).toBe("function")
    expect(typeof client.customers.signUp).toBe("function")
    expect(typeof client.entitlements.get).toBe("function")
    expect(typeof client.entitlements.verify).toBe("function")
    expect(typeof client.events.ingest).toBe("function")
    expect(typeof client.events.ingestSync).toBe("function")
    expect(typeof client.events.replayFailedIngestionEvents).toBe("function")
    expect(typeof client.replayFailedIngestionEvents).toBe("function")
    expect(typeof client.features.list).toBe("function")
    expect(typeof client.invoices.get).toBe("function")
    expect(typeof client.plans.getVersion).toBe("function")
    expect(typeof client.plans.listVersions).toBe("function")
    expect(typeof client.payments.methods.create).toBe("function")
    expect(typeof client.payments.methods.list).toBe("function")
    expect(typeof client.realtime.createTicket).toBe("function")
    expect(typeof client.analytics.explainCharge).toBe("function")
    expect(typeof client.analytics.forecastUsage).toBe("function")
    expect(typeof client.analytics.ingestion.status).toBe("function")
    expect(typeof client.subscriptions.get).toBe("function")
    expect(typeof client.analytics.usage.get).toBe("function")
    expect(typeof client.wallet.balance).toBe("function")
    expect(typeof client.wallet.creditBalance).toBe("function")
    expect(typeof client.wallet.get).toBe("function")
    expect(typeof client.billing.reservations.flushForInvoicing).toBe("function")
    expect("getPlanVersion" in client.plans).toBe(false)
    expect("getEntitlements" in client.customers).toBe(false)
    expect("usage" in client).toBe(false)
    expect("paymentMethods" in client).toBe(false)
    expect("projects" in client).toBe(false)
  })

  it("uses openapi-fetch path params, query params, body, and auth headers", async () => {
    const requests: Request[] = []
    const client = new Unprice({
      token: "test-token",
      baseUrl: "https://example.com",
      disableTelemetry: true,
      retry: { attempts: 0 },
      fetch: async (request) => {
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
      },
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
    expect(requests[0]?.url).toBe("https://example.com/v1/invoices/inv_123")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-token")
    expect(requests[0]?.headers.get("unprice-request-source")).toMatch(/^sdk@/)
  })

  it("serializes query params for GET requests", async () => {
    const requests: Request[] = []
    const client = new Unprice({
      token: "test-token",
      baseUrl: "https://example.com",
      disableTelemetry: true,
      retry: { attempts: 0 },
      fetch: async (request) => {
        requests.push(request.clone())
        const amount = {
          ledger_amount: 10,
          amount: "0.00000010",
          currency: "USD",
          display_amount: "$0.00000010",
        }
        return createJsonResponse({
          currency: "USD",
          available: {
            ...amount,
            ledger_amount: 30,
            amount: "0.00000030",
            display_amount: "$0.00000030",
          },
          held: amount,
          credits: [],
        })
      },
    })

    const { result, error } = await client.wallet.get({
      customerId: "cus_123",
      projectId: "prj_123",
    })

    expect(error).toBeUndefined()
    expect(result?.available.ledger_amount).toBe(30)
    expect(requests[0]?.url).toBe(
      "https://example.com/v1/wallet?customerId=cus_123&projectId=prj_123"
    )
  })

  it("serializes wallet balance paths and query params", async () => {
    const requests: Request[] = []
    const amount = {
      ledger_amount: 10,
      amount: "0.00000010",
      currency: "USD",
      display_amount: "$0.00000010",
    }
    const client = new Unprice({
      token: "test-token",
      baseUrl: "https://example.com",
      disableTelemetry: true,
      retry: { attempts: 0 },
      fetch: async (request) => {
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
      },
    })

    await client.wallet.balance({
      customerId: "cus_123",
      projectId: "prj_123",
    })
    const { result, error } = await client.wallet.creditBalance({
      customerId: "cus_123",
      projectId: "prj_123",
      walletId: "wcr_123",
    })

    expect(error).toBeUndefined()
    expect(result?.wallet.id).toBe("wcr_123")
    expect(requests.map((request) => request.url)).toEqual([
      "https://example.com/v1/wallet/balance?customerId=cus_123&projectId=prj_123",
      "https://example.com/v1/wallet/credits/wcr_123/balance?customerId=cus_123&projectId=prj_123",
    ])
  })

  it("sends POST bodies through the typed OpenAPI transport", async () => {
    const requests: Request[] = []
    const client = new Unprice({
      token: "test-token",
      baseUrl: "https://example.com",
      disableTelemetry: true,
      retry: { attempts: 0 },
      fetch: async (request) => {
        requests.push(request.clone())
        return createJsonResponse({
          allowed: true,
          featureSlug: "tokens",
        })
      },
    })

    const { result, error } = await client.entitlements.verify({
      customerId: "cus_123",
      featureSlug: "tokens",
    })

    expect(error).toBeUndefined()
    expect(result?.allowed).toBe(true)
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe("https://example.com/v1/entitlements/verify")
    await expect(requests[0]?.json()).resolves.toMatchObject({
      customerId: "cus_123",
      featureSlug: "tokens",
    })
  })

  it("calls replay failed ingestion endpoint", async () => {
    const requests: Request[] = []
    const client = new Unprice({
      token: "test-token",
      baseUrl: "https://example.com",
      disableTelemetry: true,
      retry: { attempts: 0 },
      fetch: async (request) => {
        requests.push(request.clone())
        return createJsonResponse({
          replayed: 1,
          skipped: 0,
        })
      },
    })

    const { result, error } = await client.replayFailedIngestionEvents({
      canonical_audit_ids: ["audit_1"],
      project_id: "proj_123",
    })

    expect(error).toBeUndefined()
    expect(result).toEqual({ replayed: 1, skipped: 0 })
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe("https://example.com/v1/events/ingest/replay")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-token")
    await expect(requests[0]?.json()).resolves.toEqual({
      canonical_audit_ids: ["audit_1"],
      project_id: "proj_123",
    })
  })

  it("maps API error payloads to the SDK result shape", async () => {
    const client = new Unprice({
      token: "test-token",
      baseUrl: "https://example.com",
      disableTelemetry: true,
      retry: { attempts: 0 },
      fetch: async () =>
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
        ),
    })

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

        return createJsonResponse({
          accepted: true,
        })
      },
    })

    const { result, error } = await client.events.ingest({
      idempotencyKey: "idem_123",
      eventSlug: "tokens",
      customerId: "cus_123",
      properties: {},
    })

    expect(error).toBeUndefined()
    expect(result?.accepted).toBe(true)
    expect(calls).toBe(2)
  })

  it("posts invoicing reservation flush requests", async () => {
    const requests: Request[] = []
    const client = new Unprice({
      token: "test-token",
      baseUrl: "https://api.test",
      disableTelemetry: true,
      retry: { attempts: 0 },
      fetch: async (request) => {
        requests.push(request.clone())
        return createJsonResponse({ ok: true, flushed: 1, skipped: 0 })
      },
    })

    const { result, error } = await client.billing.reservations.flushForInvoicing({
      customerId: "cus_123",
      subscriptionId: "sub_123",
      subscriptionPhaseId: "phase_123",
      statementKey: "stmt_123",
    })

    expect(error).toBeUndefined()
    expect(result).toEqual({ ok: true, flushed: 1, skipped: 0 })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://api.test/v1/billing/reservations/flush-for-invoicing")
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-token")
  })
})

type ExplainChargeResponse =
  paths["/v1/analytics/explain-charge"]["post"]["responses"][200]["content"]["application/json"]
type ExplainChargeEventRow = ExplainChargeResponse["events"][number]
