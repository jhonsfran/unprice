import { describe, expect, it } from "vitest"
import { decode, encode } from "./budget-store"

describe("the BudgetDO row codec", () => {
  it("round-trips amounts and caller keys that look like its bigint tag", () => {
    const row = {
      amount: BigInt("123456789012345678901"),
      properties: { $bigint: "abc", $$x: 1, plain: "7" },
      lookalike: { $bigint: "7" },
      nested: [{ $bigint: "8", other: true }],
    }
    expect(encode(row)).toBe(
      '{"amount":{"$bigint":"123456789012345678901"},"properties":{"$$bigint":"abc","$$$x":1,"plain":"7"},"lookalike":{"$$bigint":"7"},"nested":[{"$$bigint":"8","other":true}]}'
    )
    expect(decode(encode(row))).toEqual(row)
  })

  it("keeps a __proto__ key as data", () => {
    const row = Object.fromEntries([["__proto__", { $bigint: "1" }]])
    const decoded = decode<Record<string, unknown>>(encode(row))
    expect(Object.keys(decoded)).toEqual(["__proto__"])
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
  })
})
