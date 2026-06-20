import { createRoute } from "@hono/zod-openapi"
import { describe, expect, it } from "vitest"
import { defineEndpointContract } from "./endpoint-contract"

const baseRoute = {
  path: "/v1/usage/record",
  operationId: "usage.record",
  summary: "record usage",
  description: "Record usage asynchronously.",
  method: "post",
  tags: ["usage"],
  responses: {},
} as const

describe("defineEndpointContract", () => {
  it("attaches public endpoint metadata when sdk path matches the operation id", () => {
    const route = defineEndpointContract(baseRoute, {
      audience: "public",
      category: "runtime",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["usage", "record"],
      },
      idempotency: {
        required: true,
        location: "body",
        field: "idempotencyKey",
      },
    })

    expect(route["x-unprice"]).toEqual({
      audience: "public",
      category: "runtime",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["usage", "record"],
      },
      idempotency: {
        required: true,
        location: "body",
        field: "idempotencyKey",
      },
    })
  })

  it("rejects public contracts without sdk metadata", () => {
    expect(() =>
      defineEndpointContract(baseRoute, {
        audience: "public",
        category: "runtime",
      } as never)
    ).toThrow("endpoint usage.record must declare sdk metadata")
  })

  it("allows public routes to opt out of SDK generation", () => {
    const route = defineEndpointContract(
      {
        ...baseRoute,
        operationId: "usage.experimentalInspect",
      },
      {
        audience: "public",
        category: "operations",
        docs: {
          expose: true,
        },
        sdk: false,
      }
    )

    expect(route["x-unprice"].sdk).toBe(false)
  })

  it("rejects public contracts whose sdk path differs from the operation id", () => {
    expect(() =>
      defineEndpointContract(baseRoute, {
        audience: "public",
        category: "runtime",
        docs: {
          expose: true,
        },
        sdk: {
          path: ["events", "ingest"],
        },
      })
    ).toThrow("public endpoint usage.record must use sdk.path events.ingest")
  })

  it("rejects routes whose first tag does not match the public sdk namespace", () => {
    expect(() =>
      defineEndpointContract(
        {
          ...baseRoute,
          tags: ["events"],
        },
        {
          audience: "public",
          category: "runtime",
          docs: {
            expose: true,
          },
          sdk: {
            path: ["usage", "record"],
          },
        }
      )
    ).toThrow("public endpoint usage.record must use first tag usage")
  })

  it("rejects routes whose first public path segment does not match the sdk namespace", () => {
    expect(() =>
      defineEndpointContract(
        {
          ...baseRoute,
          path: "/v1/events/ingest",
        },
        {
          audience: "public",
          category: "runtime",
          docs: {
            expose: true,
          },
          sdk: {
            path: ["usage", "record"],
          },
        }
      )
    ).toThrow("public endpoint usage.record must use first /v1 path segment usage")
  })

  it("rejects SDK-exposed public routes on internal paths", () => {
    expect(() =>
      defineEndpointContract(
        {
          ...baseRoute,
          path: "/v1/internal/wallet/get",
          operationId: "wallet.get",
          tags: ["wallet"],
        },
        {
          audience: "public",
          category: "runtime",
          docs: {
            expose: true,
          },
          sdk: {
            path: ["wallet", "get"],
          },
        }
      )
    ).toThrow("public endpoint wallet.get cannot use an internal path")
  })

  it("preserves endpoint metadata when passed through createRoute", () => {
    const contract = {
      audience: "public",
      category: "runtime",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["usage", "record"],
      },
    } as const

    const route = createRoute(defineEndpointContract(baseRoute, contract))

    expect(route["x-unprice"]).toEqual(contract)
  })

  it("allows internal routes with sdk disabled", () => {
    const route = defineEndpointContract(
      {
        ...baseRoute,
        path: "/v1/internal/billing-reservations/flush-for-invoicing",
        operationId: "billingReservations.flushForInvoicing",
        tags: ["billingReservations"],
      },
      {
        audience: "internal",
        category: "operations",
        docs: {
          expose: false,
        },
        sdk: false,
      }
    )

    expect(route["x-unprice"].audience).toBe("internal")
  })

  it("rejects internal routes with SDK metadata", () => {
    expect(() =>
      defineEndpointContract(
        {
          ...baseRoute,
          path: "/v1/internal/usage/record",
        },
        {
          audience: "internal",
          category: "operations",
          docs: {
            expose: false,
          },
          sdk: {
            path: ["usage", "record"],
          },
        }
      )
    ).toThrow("internal endpoint usage.record must use sdk: false")
  })
})
