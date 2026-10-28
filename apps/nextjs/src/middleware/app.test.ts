import { NextRequest, NextResponse } from "next/server"
import { describe, expect, it, vi } from "vitest"

import type { NextAuthRequest } from "@unprice/auth"
import { COOKIES_APP } from "@unprice/config"
import { SIGNUP_INTENT_COOKIE } from "~/lib/signup-funnel"
import AppMiddleware from "./app"

function createRequest(
  url: string,
  { workspaces, cookie }: { workspaces?: Array<{ slug: string }>; cookie?: string } = {}
) {
  const request = new NextRequest(url, {
    headers: { host: "app.localhost:3000", ...(cookie ? { cookie } : {}) },
  })
  return Object.assign(request, {
    auth: workspaces ? { user: { workspaces } } : null,
  }) as unknown as NextAuthRequest
}

function createWorkspaceProjectRequest() {
  const request = new NextRequest("http://app.localhost:3000/thoughtless-wolf/bewildered-gpu", {
    headers: {
      cookie: `${COOKIES_APP.WORKSPACE}=previous-workspace; ${COOKIES_APP.PROJECT}=previous-project`,
      host: "app.localhost:3000",
    },
  })

  return Object.assign(request, {
    auth: {
      user: {
        workspaces: [{ slug: "thoughtless-wolf" }],
      },
    },
  }) as unknown as NextAuthRequest
}

describe("AppMiddleware", () => {
  it("forwards route scope to the rewritten request when existing scope cookies are stale", () => {
    const rewrite = vi.spyOn(NextResponse, "rewrite")

    const response = AppMiddleware(createWorkspaceProjectRequest())
    const options = rewrite.mock.calls[0]?.[1]

    if (!options?.request?.headers) {
      throw new Error("Expected the middleware rewrite to forward request headers")
    }

    const forwardedCookie = options.request.headers.get("cookie")

    expect(forwardedCookie).toContain(`${COOKIES_APP.WORKSPACE}=thoughtless-wolf`)
    expect(forwardedCookie).toContain(`${COOKIES_APP.PROJECT}=bewildered-gpu`)
    expect(response.cookies.get(COOKIES_APP.WORKSPACE)?.value).toBe("thoughtless-wolf")
    expect(response.cookies.get(COOKIES_APP.PROJECT)?.value).toBe("bewildered-gpu")
  })
})

describe("AppMiddleware signup intent", () => {
  it("remembers a signup intent in a short-lived cookie", () => {
    const response = AppMiddleware(
      createRequest("http://app.localhost:3000/auth/signup?intent=budgets&next=%2Fnew")
    )

    const cookie = response.cookies.get(SIGNUP_INTENT_COOKIE)
    expect(cookie?.value).toBe("budgets")
    expect(cookie?.maxAge).toBe(60 * 30)
    expect(cookie?.httpOnly).toBe(true)
  })

  it("ignores an unknown intent", () => {
    const response = AppMiddleware(createRequest("http://app.localhost:3000/auth/signup?intent=x"))

    expect(response.cookies.get(SIGNUP_INTENT_COOKIE)).toBeUndefined()
  })

  it("sends a new user without a workspace to /new with the remembered intent", () => {
    const response = AppMiddleware(
      createRequest("http://app.localhost:3000/", {
        workspaces: [],
        cookie: `${SIGNUP_INTENT_COOKIE}=budgets`,
      })
    )

    expect(response.headers.get("location")).toBe("http://app.localhost:3000/new?intent=budgets")
  })

  it("sends a new user without an intent to plain /new", () => {
    const response = AppMiddleware(createRequest("http://app.localhost:3000/", { workspaces: [] }))

    expect(response.headers.get("location")).toBe("http://app.localhost:3000/new")
  })

  it("keeps an existing user on their workspace", () => {
    const response = AppMiddleware(
      createRequest("http://app.localhost:3000/", {
        workspaces: [{ slug: "acme" }],
        cookie: `${SIGNUP_INTENT_COOKIE}=budgets`,
      })
    )

    expect(response.headers.get("location")).toBe("http://app.localhost:3000/acme")
  })
})
