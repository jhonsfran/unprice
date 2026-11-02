import { describe, expect, it } from "vitest"

import { APP_DOMAIN, AUTH_ROUTES, BASE_URL } from "@unprice/config"

import {
  ACQUISITION_SIGNUP_URL,
  PRIVACY_URL,
  type SignupIntent,
  TERMS_URL,
  acquisitionSignupHref,
  authNextPath,
  buildAuthHref,
  createFunnelPageEventClaimer,
  getSafeNextPath,
  getSignupIntent,
  getSingleSearchParam,
  intentForMarketingPath,
  intentLanding,
  newWorkspacePath,
  nextAfterAuth,
  resolveSignupIntent,
  signupIntentSchema,
  workspaceLanding,
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

  it("carries the budgets intent through auth and workspace creation to the Budgets setup", () => {
    const next = nextAfterAuth("budgets")
    const href = buildAuthHref(AUTH_ROUTES.SIGNUP, { intent: "budgets", next })
    const url = new URL(href, "https://app.example")

    expect(getSignupIntent("budgets")).toBe("budgets")
    expect(url.searchParams.get("intent")).toBe("budgets")
    expect(url.searchParams.get("next")).toBe("/new?intent=budgets")
    expect(getSafeNextPath(next)).toBe("/new?intent=budgets")
    expect(newWorkspacePath("budgets")).toBe("/new?intent=budgets")
    expect(intentLanding("acme", "budgets")).toBe("/acme/onboarding/budgets")
    expect(workspaceLanding("acme", "budgets")).toBe("/acme/onboarding/budgets")
  })

  it("routes a bare budgets intent through /new when the link carries no next", () => {
    expect(authNextPath(undefined, "budgets")).toBe("/new?intent=budgets")
    expect(authNextPath("/acme/settings", "budgets")).toBe("/acme/settings")
    expect(authNextPath("https://evil.example", "budgets")).toBe("/new?intent=budgets")
    expect(authNextPath(undefined, "paid-action")).toBeNull()
    expect(authNextPath(undefined)).toBeNull()
  })

  it("lands the paid-action intent, and no intent, on the workspace itself", () => {
    expect(nextAfterAuth("paid-action")).toBeUndefined()
    expect(newWorkspacePath("paid-action")).toBe("/new?intent=paid-action")
    expect(newWorkspacePath()).toBe("/new")
    expect(intentLanding("acme", "paid-action")).toBeNull()
    expect(intentLanding("acme")).toBeNull()
    expect(workspaceLanding("acme", "paid-action")).toBe("/acme")
    expect(workspaceLanding("acme")).toBe("/acme")
  })

  it.each(signupIntentSchema.options)(
    "routes the %s intent to a safe path on every step",
    (intent: SignupIntent) => {
      const next = nextAfterAuth(intent)
      if (next !== undefined) expect(getSafeNextPath(next)).toBe(next)
      expect(getSafeNextPath(newWorkspacePath(intent))).toBe(newWorkspacePath(intent))
      expect(workspaceLanding("acme", intent).startsWith("/acme")).toBe(true)
    }
  )

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

describe("Budgets signup intent", () => {
  it("renders the Budgets CTA with its intent and next before any click", () => {
    const href = new URL(acquisitionSignupHref("budgets"))

    expect(href.origin).toBe(new URL(APP_DOMAIN).origin)
    expect(href.pathname).toBe(AUTH_ROUTES.SIGNUP)
    expect(href.searchParams.get("intent")).toBe("budgets")
    expect(href.searchParams.get("next")).toBe("/new?intent=budgets")
    expect(href.searchParams.has("sessionId")).toBe(false)
  })

  it("adds the conversion session on click without dropping the intent", () => {
    const href = new URL(acquisitionSignupHref("budgets", "sess_1"))

    expect(href.searchParams.get("sessionId")).toBe("sess_1")
    expect(href.searchParams.get("intent")).toBe("budgets")
    expect(href.searchParams.get("next")).toBe("/new?intent=budgets")
  })

  it("keeps the paid-action CTA on the workspace itself", () => {
    const href = new URL(acquisitionSignupHref("paid-action"))

    expect(href.searchParams.get("intent")).toBe("paid-action")
    expect(href.searchParams.has("next")).toBe(false)
  })

  it("starts Budgets from the /budgets page header and the proof everywhere else", () => {
    expect(intentForMarketingPath("/budgets")).toBe("budgets")
    expect(intentForMarketingPath("/budgets/")).toBe("budgets")
    expect(intentForMarketingPath("/")).toBe("paid-action")
    expect(intentForMarketingPath("/budgetsx")).toBe("paid-action")
    expect(intentForMarketingPath(null)).toBe("paid-action")
  })

  it("prefers the query intent and falls back to the signup cookie", () => {
    expect(resolveSignupIntent("budgets", "paid-action")).toBe("budgets")
    expect(resolveSignupIntent(undefined, "budgets")).toBe("budgets")
    expect(resolveSignupIntent("bogus", "budgets")).toBe("budgets")
    expect(resolveSignupIntent(undefined, "bogus")).toBeUndefined()
    expect(resolveSignupIntent(undefined, undefined)).toBeUndefined()
  })

  it("lands a new Budgets workspace on the Budgets setup", () => {
    expect(workspaceLanding("acme", resolveSignupIntent(undefined, "budgets"))).toBe(
      "/acme/onboarding/budgets"
    )
  })
})
