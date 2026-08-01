import { describe, expect, it } from "vitest"
import { getCanonicalAuthRedirectUrl } from "./redirect-policy"

const APP_DOMAIN = "http://app.localhost:3000/"

describe("getCanonicalAuthRedirectUrl", () => {
  it("resolves relative destinations against the canonical app origin", () => {
    expect(getCanonicalAuthRedirectUrl("/acme?tab=keys", APP_DOMAIN)).toBe(
      new URL("/acme?tab=keys", APP_DOMAIN).toString()
    )
  })

  it("preserves absolute destinations on the canonical app origin", () => {
    const destination = new URL("/acme", APP_DOMAIN).toString()

    expect(getCanonicalAuthRedirectUrl(destination, APP_DOMAIN)).toBe(destination)
  })

  it("rejects destinations on every other origin", () => {
    expect(getCanonicalAuthRedirectUrl("https://evil.example", APP_DOMAIN)).toBe(APP_DOMAIN)
    expect(getCanonicalAuthRedirectUrl("//evil.example", APP_DOMAIN)).toBe(APP_DOMAIN)
  })
})
