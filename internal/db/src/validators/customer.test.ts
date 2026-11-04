import { describe, expect, it } from "vitest"

import { customerSignUpSchema } from "./customer"

const baseSignUpInput = {
  name: "Acme Inc.",
  email: "billing@acme.test",
  successUrl: "https://example.com/dashboard",
  cancelUrl: "https://example.com/login",
}

describe("customerSignUpSchema", () => {
  it("allows omitting planSlug and planVersionId so signup can use the default plan", () => {
    const result = customerSignUpSchema.safeParse(baseSignUpInput)

    expect(result.success).toBe(true)
  })

  it("rejects passing both planSlug and planVersionId", () => {
    const result = customerSignUpSchema.safeParse({
      ...baseSignUpInput,
      planSlug: "pro",
      planVersionId: "pv_123",
    })

    expect(result.success).toBe(false)
  })

  it("bounds the attribution ids: no control characters, quotes, or unbounded length", () => {
    const parse = (fields: Record<string, string>) =>
      customerSignUpSchema.safeParse({ ...baseSignUpInput, ...fields }).success

    expect(parse({ sessionId: "8f14e45f-ceea-4e7a-9b1d-2f6a1c0b7d11", pageId: "page_1" })).toBe(
      true
    )
    expect(parse({ sessionId: "sess\u0000" })).toBe(false)
    expect(parse({ sessionId: "sess'1" })).toBe(false)
    expect(parse({ sessionId: "" })).toBe(false)
    expect(parse({ sessionId: "s".repeat(129) })).toBe(false)
    expect(parse({ pageId: "page\n1" })).toBe(false)
    expect(parse({ planVersionId: "pv 1" })).toBe(false)
  })
})
