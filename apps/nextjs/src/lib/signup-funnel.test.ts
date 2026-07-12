import { describe, expect, it } from "vitest"

import { APP_DOMAIN, AUTH_ROUTES, BASE_URL } from "@unprice/config"

import {
  ACQUISITION_SIGNUP_URL,
  PRIVACY_URL,
  TERMS_URL,
  buildAuthHref,
  createFunnelPageEventClaimer,
  getSafeNextPath,
  getSignupIntent,
  getSingleSearchParam,
} from "./signup-funnel"

describe("signup funnel URLs", () => {
  it("uses canonical app and marketing URLs", () => {
    const signupUrl = new URL(ACQUISITION_SIGNUP_URL)
    const termsUrl = new URL(TERMS_URL)
    const privacyUrl = new URL(PRIVACY_URL)

    expect(signupUrl.origin).toBe(new URL(APP_DOMAIN).origin)
    expect(signupUrl.pathname).toBe("/auth/signup")
    expect(termsUrl.href).toBe(new URL("/terms", BASE_URL).href)
    expect(privacyUrl.href).toBe(new URL("/privacy", BASE_URL).href)
  })

  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "%2F%2Fevil.example",
    "/%5Cevil.example",
    "/\t//evil.example",
    "/\r//evil.example",
    "/\n//evil.example",
    "/%09//evil.example",
    "/%0D//evil.example",
    "/%0A//evil.example",
    "/%",
  ])("rejects unsafe next paths: %s", (next) => {
    expect(getSafeNextPath(next)).toBeNull()
  })

  it("preserves a safe relative next path", () => {
    expect(getSafeNextPath("/acme/onboarding?step=project")).toBe("/acme/onboarding?step=project")
  })

  it("rejects repeated query parameters before building auth URLs", () => {
    const sessionId = getSingleSearchParam(["session_123", "session_456"])
    const next = getSafeNextPath(getSingleSearchParam(["/acme/onboarding", "/other"]))

    expect(getSingleSearchParam("session_123")).toBe("session_123")
    expect(sessionId).toBeUndefined()
    expect(next).toBeNull()
    expect(buildAuthHref(AUTH_ROUTES.SIGNIN, { sessionId, next })).toBe(AUTH_ROUTES.SIGNIN)
  })

  it("builds auth hrefs with a session and a safe next path", () => {
    const href = buildAuthHref(AUTH_ROUTES.SIGNUP, {
      sessionId: "session_123",
      next: "/acme/onboarding?step=project",
    })
    const url = new URL(href, "https://app.example")

    expect(url.pathname).toBe(AUTH_ROUTES.SIGNUP)
    expect(url.searchParams.get("sessionId")).toBe("session_123")
    expect(url.searchParams.get("next")).toBe("/acme/onboarding?step=project")
  })

  it("preserves the paid-action intent across auth links", () => {
    const href = buildAuthHref(AUTH_ROUTES.SIGNUP, {
      sessionId: "session_123",
      intent: "paid-action",
      next: "/acme/onboarding",
    })
    const url = new URL(href, "https://app.example")

    expect(url.searchParams.get("intent")).toBe("paid-action")
    expect(getSignupIntent("paid-action")).toBe("paid-action")
    expect(getSignupIntent("other")).toBeUndefined()
    expect(getSignupIntent(["paid-action", "other"])).toBeUndefined()
  })

  it("omits empty optional params", () => {
    expect(buildAuthHref(AUTH_ROUTES.SIGNIN, {})).toBe(AUTH_ROUTES.SIGNIN)
    expect(buildAuthHref(AUTH_ROUTES.SIGNIN, { sessionId: "", next: "" })).toBe(AUTH_ROUTES.SIGNIN)
  })

  it("retains the session when next is rejected", () => {
    const href = buildAuthHref(AUTH_ROUTES.SIGNUP, {
      sessionId: "session_123",
      next: "https://evil.example",
    })
    const url = new URL(href, "https://app.example")

    expect(url.searchParams.get("sessionId")).toBe("session_123")
    expect(url.searchParams.has("next")).toBe(false)
  })
})

describe("funnel page event claims", () => {
  it("claims each page URL once", () => {
    const claimFunnelPageEvent = createFunnelPageEventClaimer()

    expect(claimFunnelPageEvent("/auth/signup?sessionId=session_123")).toBe(true)
    expect(claimFunnelPageEvent("/auth/signup?sessionId=session_123")).toBe(false)
    expect(claimFunnelPageEvent("/auth/signup?sessionId=session_456")).toBe(true)
  })
})
