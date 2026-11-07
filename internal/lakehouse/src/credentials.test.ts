import { assertAllOrNoneConfigured } from "@unprice/lakehouse"
import { describe, expect, it } from "vitest"

describe("lakehouse credential sets", () => {
  it("accepts a set that is fully configured or not configured at all", () => {
    expect(() => assertAllOrNoneConfigured({ A: "a", B: "b" })).not.toThrow()
    expect(() => assertAllOrNoneConfigured({ A: undefined, B: "" })).not.toThrow()
  })

  it("names the missing variables of a partly configured set", () => {
    expect(() =>
      assertAllOrNoneConfigured({ BASIN_SQL_ACCOUNT_ID: "acc", BASIN_SQL_BUCKET: undefined })
    ).toThrow(
      "BASIN_SQL_ACCOUNT_ID, BASIN_SQL_BUCKET must be set together or not at all; missing BASIN_SQL_BUCKET"
    )
  })
})
