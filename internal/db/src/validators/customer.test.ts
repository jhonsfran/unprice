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
})
