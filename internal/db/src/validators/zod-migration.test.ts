import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  subscriptionChangePlanSchema,
  subscriptionInsertSchema,
  subscriptionPhaseInsertSchema,
} from "./subscriptions/subscription"

describe("Zod v4 boundary compatibility", () => {
  it("keeps nullable insert fields optional instead of manufacturing defaults", () => {
    const subscription = subscriptionInsertSchema
      .omit({ phases: true })
      .parse({ customerId: "c_1" })
    expect(subscription).not.toHaveProperty("metadata")
    expect(subscription).not.toHaveProperty("timezone")
    expect(subscriptionInsertSchema.shape.metadata.parse(null)).toBeNull()
    expect(subscriptionPhaseInsertSchema.shape.trialUnits.parse(undefined)).toBeUndefined()
    expect(subscriptionPhaseInsertSchema.shape.creditLinePolicy.parse(undefined)).toBeUndefined()
    expect(subscriptionChangePlanSchema.shape.creditLinePolicy.parse(undefined)).toBeUndefined()
  })

  it("rejects an oversized bounded array before validating its elements", () => {
    let visited = 0
    const schema = z
      .array(
        z.string().refine(() => {
          visited++
          return false
        })
      )
      .max(1)

    const result = schema.safeParse(["first", "second"])
    expect(result.success).toBe(false)
    expect(result.error?.issues).toMatchObject([{ code: "too_big", path: [] }])
    expect(visited).toBe(0)
  })
})
