import { describe, expect, it, vi } from "vitest"
import { pricingCtaHref, trackWebEvent } from "./pricing-cta"

describe("pricing CTA", () => {
  it("does not throw when track.js is not loaded", () => {
    expect(() => trackWebEvent("plan_click", { plan_version_id: "pv_1" }, {})).not.toThrow()
    expect(() => trackWebEvent("plan_click", { plan_version_id: "pv_1" }, undefined)).not.toThrow()
  })

  it("swallows a tracker that throws", () => {
    const trackEvent = vi.fn(() => {
      throw new Error("blocked")
    })

    expect(() => trackWebEvent("plan_click", {}, { Unprice: { trackEvent } })).not.toThrow()
    expect(trackEvent).toHaveBeenCalledWith("plan_click", {})
  })

  it("carries the plan and page on the link", () => {
    expect(
      pricingCtaHref("https://app.example/auth/signup", { planVersionId: "pv_1", pageId: "page_1" })
    ).toBe("https://app.example/auth/signup?planVersionId=pv_1&pageId=page_1")
  })
})
