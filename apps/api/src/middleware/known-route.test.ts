import { describe, expect, it } from "vitest"
import { isKnownRoute } from "./known-route"

const routes = [
  { method: "ALL", path: "*" },
  { method: "GET", path: "/openapi.json" },
  { method: "GET", path: "/reference" },
  { method: "ALL", path: "/broadcast/**" },
  { method: "POST", path: "/v1/entitlements/verify" },
  { method: "POST", path: "/v1/events/ingest" },
  { method: "GET", path: "/v1/invoices/{invoiceId}" },
  { method: "GET", path: "/v1/wallet/credits/:walletId/balance" },
  { method: "POST", path: "/v1/payments/providers/{provider}/webhook/{projectId}" },
] as const

describe("isKnownRoute", () => {
  it("allows registered API routes", () => {
    expect(isKnownRoute("POST", "/v1/entitlements/verify", routes)).toBe(true)
    expect(isKnownRoute("GET", "/v1/invoices/inv_123", routes)).toBe(true)
    expect(isKnownRoute("GET", "/v1/wallet/credits/wcr_123/balance", routes)).toBe(true)
    expect(isKnownRoute("POST", "/v1/payments/providers/stripe/webhook/proj_123", routes)).toBe(
      true
    )
  })

  it("allows support and websocket routes", () => {
    expect(isKnownRoute("GET", "/favicon.ico", routes)).toBe(true)
    expect(isKnownRoute("GET", "/openapi.json", routes)).toBe(true)
    expect(isKnownRoute("HEAD", "/reference", routes)).toBe(true)
    expect(isKnownRoute("GET", "/broadcast", routes)).toBe(true)
    expect(isKnownRoute("GET", "/broadcast/entitlements/proj_123/cus_123", routes)).toBe(true)
  })

  it("allows CORS preflight only for known routes", () => {
    expect(isKnownRoute("OPTIONS", "/v1/events/ingest", routes)).toBe(true)
    expect(isKnownRoute("OPTIONS", "/clss.php", routes)).toBe(false)
  })

  it("rejects unknown paths and unsupported methods before service init", () => {
    expect(isKnownRoute("GET", "/clss.php", routes)).toBe(false)
    expect(isKnownRoute("GET", "/wp-admin", routes)).toBe(false)
    expect(isKnownRoute("GET", "/v1/events/ingest", routes)).toBe(false)
    expect(isKnownRoute("DELETE", "/v1/events/ingest", routes)).toBe(false)
  })
})
