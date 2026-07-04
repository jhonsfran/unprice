import { describe, expect, it } from "vitest"

import { workspaceSignupSchema } from "./workspace"

const baseWorkspaceSignupInput = {
  name: "Acme Inc.",
  successUrl: "https://example.com/new",
  cancelUrl: "https://example.com",
}

describe("workspaceSignupSchema", () => {
  it("allows omitting planVersionId so signup can resolve the default plan", () => {
    const result = workspaceSignupSchema.safeParse(baseWorkspaceSignupInput)

    expect(result.success).toBe(true)
  })

  it("rejects an empty planVersionId when one is provided", () => {
    const result = workspaceSignupSchema.safeParse({
      ...baseWorkspaceSignupInput,
      planVersionId: "",
    })

    expect(result.success).toBe(false)
  })
})
