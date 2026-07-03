import { describe, expect, it } from "vitest"
import { shouldTrustAuthHost, shouldUseSecureAuthCookies } from "./runtime"

describe("auth runtime flags", () => {
  it("uses secure cookies outside local development", () => {
    expect(shouldUseSecureAuthCookies("development")).toBe(false)
    expect(shouldUseSecureAuthCookies("preview")).toBe(true)
    expect(shouldUseSecureAuthCookies("production")).toBe(true)
  })

  it("trusts host headers only for local dev and deployed environments", () => {
    expect(shouldTrustAuthHost({ appEnv: "development", nodeEnv: "development" })).toBe(true)
    expect(shouldTrustAuthHost({ appEnv: "development", nodeEnv: "test" })).toBe(false)
    expect(shouldTrustAuthHost({ appEnv: "preview", nodeEnv: "production" })).toBe(true)
    expect(shouldTrustAuthHost({ appEnv: "production", nodeEnv: "production" })).toBe(true)
  })
})
