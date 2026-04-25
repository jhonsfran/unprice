import { describe, expect, it } from "vitest"
import {
  PLATFORM_FUNDING_KINDS,
  customerAccountKeys,
  customerAvailableKeys,
  platformAccountKey,
} from "./accounts"

describe("account keys", () => {
  it("builds the customer sub-account keys", () => {
    expect(customerAccountKeys("cus_123")).toEqual({
      purchased: "customer.cus_123.available.purchased",
      granted: "customer.cus_123.available.granted",
      reserved: "customer.cus_123.reserved",
      consumed: "customer.cus_123.consumed",
      receivable: "customer.cus_123.receivable",
    })
  })

  it("returns available accounts in drain priority order (granted first)", () => {
    expect(customerAvailableKeys("cus_123")).toEqual([
      "customer.cus_123.available.granted",
      "customer.cus_123.available.purchased",
    ])
  })

  it("builds platform funding keys with kind + project", () => {
    expect(platformAccountKey("topup", "proj_1")).toBe("platform.proj_1.funding.topup")
    expect(platformAccountKey("promo", "proj_1")).toBe("platform.proj_1.funding.promo")
    expect(platformAccountKey("plan_credit", "proj_1")).toBe("platform.proj_1.funding.plan_credit")
    expect(platformAccountKey("manual", "proj_1")).toBe("platform.proj_1.funding.manual")
    expect(platformAccountKey("credit_line", "proj_1")).toBe("platform.proj_1.funding.credit_line")
  })

  it("ships the canonical platform funding kinds", () => {
    expect(PLATFORM_FUNDING_KINDS).toEqual([
      "topup",
      "promo",
      "plan_credit",
      "manual",
      "credit_line",
    ])
  })
})
