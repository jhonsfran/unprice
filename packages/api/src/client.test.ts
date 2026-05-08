import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { Unprice } from "./client"

const createJsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    status: init?.status ?? 200,
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

describe("Unprice client", () => {
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
    expect(typeof client.features.list).toBe("function")
    expect(typeof client.invoices.get).toBe("function")
    expect(typeof client.lakehouse.getFilePlan).toBe("function")
    expect(typeof client.plans.getVersion).toBe("function")
    expect(typeof client.plans.listVersions).toBe("function")
    expect(typeof client.payments.methods.create).toBe("function")
    expect(typeof client.payments.methods.list).toBe("function")
    expect(typeof client.realtime.createTicket).toBe("function")
    expect(typeof client.subscriptions.get).toBe("function")
    expect(typeof client.usage.get).toBe("function")
    expect(typeof client.wallet.get).toBe("function")
    expect("getPlanVersion" in client.plans).toBe(false)
    expect("getEntitlements" in client.customers).toBe(false)
    expect("analytics" in client).toBe(false)
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
            total_amount: 100,
          },
          lines: [],
        })
      },
    })

    const { result, error } = await client.invoices.get({ invoiceId: "inv_123" })

    expect(error).toBeUndefined()
    expect(result?.invoice.id).toBe("inv_123")
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
            purchased: amount,
            granted: amount,
            total: {
              ...amount,
              ledger_amount: 30,
              amount: "0.00000030",
              display_amount: "$0.00000030",
            },
          },
          reserved: amount,
          consumed: amount,
          credits: [],
        })
      },
    })

    const { result, error } = await client.wallet.get({
      customerId: "cus_123",
      projectId: "prj_123",
    })

    expect(error).toBeUndefined()
    expect(result?.available.total.ledger_amount).toBe(30)
    expect(requests[0]?.url).toBe(
      "https://example.com/v1/wallet?customerId=cus_123&projectId=prj_123"
    )
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
          status: "active",
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
})

describe("API route metadata", () => {
  it("matches the SDK namespace methods", () => {
    const apiRoutes = collectApiRoutes()
    const publicApiRoutes = apiRoutes.filter(
      (route) => !route.path.startsWith("/v1/payments/providers/")
    )
    const apiOperationIds = publicApiRoutes.map((route) => route.operationId).sort()
    const sdkOperationIds = collectSdkOperationIds()

    const routesWithMismatchedTags = apiRoutes.filter(
      (route) => route.tag !== getOperationNamespace(route.operationId)
    )
    const routesWithMismatchedPathNamespaces = apiRoutes.filter(
      (route) => route.tag !== getPathNamespace(route.path)
    )

    const missingFromSdk = apiOperationIds.filter(
      (operationId) => !sdkOperationIds.has(operationId)
    )
    const sdkOnly = [...sdkOperationIds].filter(
      (operationId) => !apiOperationIds.includes(operationId)
    )

    expect(routesWithMismatchedTags).toEqual([])
    expect(routesWithMismatchedPathNamespaces).toEqual([])
    expect(missingFromSdk).toEqual([])
    expect(sdkOnly).toEqual([])
  })
})

const collectApiRoutes = () => {
  const routeFiles = collectRouteFiles(resolve(__dirname, "../../../apps/api/src/routes"))

  return routeFiles
    .map((file) => {
      const source = readFileSync(file, "utf8")
      const path = source.match(/path:\s*"([^"]+)"/)?.[1]
      const method = source.match(/method:\s*"([^"]+)"/)?.[1]
      const operationId = source.match(/operationId:\s*"([^"]+)"/)?.[1]
      const tag = source.match(/const tags = \[\s*"([^"]+)"/)?.[1]

      if (!path) {
        return null
      }

      return {
        method: method?.toUpperCase() ?? `MISSING_METHOD:${file}`,
        operationId: operationId ?? `MISSING_OPERATION_ID:${file}`,
        path,
        tag: tag ?? `MISSING_TAG:${file}`,
      }
    })
    .filter(
      (route): route is { method: string; operationId: string; path: string; tag: string } => {
        return route !== null
      }
    )
    .sort((left, right) => left.operationId.localeCompare(right.operationId))
}

const getPathNamespace = (path: string) => path.split("/").filter(Boolean)[1] ?? ""

const getOperationNamespace = (operationId: string) => {
  const separatorIndex = operationId.indexOf(".")

  if (separatorIndex === -1) {
    return operationId
  }

  return operationId.slice(0, separatorIndex)
}

const collectSdkOperationIds = () => {
  const client = new Unprice({
    token: "test-token",
    baseUrl: "https://example.com",
    disableTelemetry: true,
    retry: { attempts: 0 },
    fetch: async () => createJsonResponse({}),
  })
  const descriptors = Object.getOwnPropertyDescriptors(Unprice.prototype)

  return new Set(
    Object.entries(descriptors)
      .flatMap(([namespace, descriptor]) => {
        const getter = descriptor.get as ((this: Unprice) => unknown) | undefined

        if (!getter) {
          return []
        }

        const resource = getter.call(client)

        if (!isRecord(resource)) {
          return []
        }

        return collectSdkResourceMethods(namespace, resource)
      })
      .sort()
  )
}

const collectSdkResourceMethods = (
  namespace: string,
  resource: Record<string, unknown>
): string[] =>
  Object.entries(resource).flatMap(([name, value]) => {
    if (typeof value === "function") {
      return `${namespace}.${name}`
    }

    if (isRecord(value)) {
      return collectSdkResourceMethods(`${namespace}.${name}`, value)
    }

    return []
  })

const collectRouteFiles = (dir: string): string[] => {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)

    if (entry.isDirectory()) {
      return collectRouteFiles(path)
    }

    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      return []
    }

    return [path]
  })
}
