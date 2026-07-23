import { describe, expect, it } from "vitest"
import { planVersionMetadataSchema } from "./planVersions"

describe("planVersionMetadataSchema", () => {
  it("accepts metadata without includedCreditAmount", () => {
    expect(planVersionMetadataSchema.parse({})).toEqual({})
    expect(planVersionMetadataSchema.parse({ externalId: "price_123" })).toEqual({
      externalId: "price_123",
    })
  })

  it("accepts a positive ledger-scale included credit amount", () => {
    expect(planVersionMetadataSchema.parse({ includedCreditAmount: 2_000_000_000 })).toEqual({
      includedCreditAmount: 2_000_000_000,
    })
  })

  it("rejects zero, negative, fractional, and unsafe amounts", () => {
    expect(() => planVersionMetadataSchema.parse({ includedCreditAmount: 0 })).toThrow()
    expect(() => planVersionMetadataSchema.parse({ includedCreditAmount: -5 })).toThrow()
    expect(() => planVersionMetadataSchema.parse({ includedCreditAmount: 1.5 })).toThrow()
    expect(() =>
      planVersionMetadataSchema.parse({ includedCreditAmount: Number.MAX_SAFE_INTEGER + 2 })
    ).toThrow()
  })
})
