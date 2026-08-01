import { NextRequest } from "next/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@unprice/auth/server", () => ({
  auth: <T>(handler: T) => handler,
}))

vi.mock("~/middleware/app", () => ({ default: vi.fn() }))
vi.mock("~/middleware/sites", () => ({ default: vi.fn() }))
vi.mock("~/lib/domains", () => ({
  getValidSubdomain: () => "",
  parse: () => ({
    domain: "localhost:3000",
    fullPath: "/auth/signin?next=%2Facme",
    path: "/auth/signin",
  }),
}))

import middleware from "./middleware"

describe("root middleware", () => {
  it("moves base-host auth requests to the canonical app host", async () => {
    const request = new NextRequest("http://localhost:3000/auth/signin?next=%2Facme", {
      headers: { host: "localhost:3000" },
    })
    const response = await middleware(request, {} as never)

    if (!response) {
      throw new Error("Expected the middleware to return a response")
    }

    const location = response.headers.get("location")

    expect(response.status).toBe(307)
    expect(location).not.toBeNull()

    const redirect = new URL(location ?? "")
    expect(redirect.origin).toBe("http://app.localhost:3000")
    expect(redirect.pathname).toBe("/auth/signin")
    expect(redirect.searchParams.get("next")).toBe("/acme")
  })
})
