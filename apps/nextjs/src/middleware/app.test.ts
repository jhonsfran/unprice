import { NextRequest, NextResponse } from "next/server"
import { describe, expect, it, vi } from "vitest"

import type { NextAuthRequest } from "@unprice/auth"
import { COOKIES_APP } from "@unprice/config"
import AppMiddleware from "./app"

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
