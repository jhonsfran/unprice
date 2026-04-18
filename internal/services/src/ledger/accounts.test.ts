import { describe, expect, it } from "vitest"
import {
  HOUSE_ACCOUNT_KINDS,
  customerAccountKey,
  grantAccountKey,
  houseAccountKey,
} from "./accounts"

describe("account keys", () => {
  it("builds customer keys with currency", () => {
    expect(customerAccountKey("cus_123", "USD")).toBe("customer:cus_123:USD")
  })

  it("builds house keys with kind, project, currency", () => {
    expect(houseAccountKey("revenue", "proj_1", "EUR")).toBe("house:revenue:proj_1:EUR")
  })

  it("exposes a grant key helper", () => {
    expect(grantAccountKey("grant_abc")).toBe("grant:grant_abc")
  })

  it("ships the four canonical house kinds", () => {
    expect(HOUSE_ACCOUNT_KINDS).toEqual([
      "revenue",
      "credit_issuance",
      "expired_credits",
      "refunds",
    ])
  })
})
