import { describe, expect, it } from "vitest"
import { MAX_PLAN_IDS_PER_HIT, parseTrackingRequest, planViewRows } from "./web-tracking"

const hit = {
  page_id: "page_1",
  plan_ids: "pv_1,pv_2,pv_1,",
  locale: "en-US",
  referrer: "",
  pathname: "/",
  url: "https://acme.unprice.dev/",
}

function body(action: string, payload: unknown) {
  return {
    action,
    session_id: "sess_1",
    project_id: "proj_1",
    payload: JSON.stringify(payload),
  }
}

describe("tracking beacon", () => {
  it("parses a page hit into one plan view per distinct plan", () => {
    const parsed = parseTrackingRequest(body("page_hit", hit))

    expect(parsed.success).toBe(true)
    if (!parsed.success || parsed.data.action !== "page_hit") return
    expect(parsed.data.payload.plan_ids).toEqual(["pv_1", "pv_2"])
    expect(
      planViewRows(parsed.data).map((row) => [row.plan_version_id, row.session_id, row.project_id])
    ).toEqual([
      ["pv_1", "sess_1", "proj_1"],
      ["pv_2", "sess_1", "proj_1"],
    ])
  })

  it("accepts a page without plans", () => {
    const parsed = parseTrackingRequest(body("page_hit", { ...hit, plan_ids: null }))

    expect(
      parsed.success && parsed.data.action === "page_hit" && parsed.data.payload.plan_ids
    ).toEqual([])
  })

  it("never lets payload keys override the envelope's session and project", () => {
    const parsed = parseTrackingRequest(
      body("page_hit", { ...hit, session_id: "forged", project_id: "proj_other" })
    )

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.session_id).toBe("sess_1")
    expect(parsed.data.project_id).toBe("proj_1")
    expect(parsed.data.payload).not.toHaveProperty("session_id")
  })

  it("rejects more plan ids than a pricing page shows", () => {
    const planIds = Array.from({ length: MAX_PLAN_IDS_PER_HIT + 1 }, (_, i) => `pv_${i}`)

    expect(
      parseTrackingRequest(body("page_hit", { ...hit, plan_ids: planIds.join(",") })).success
    ).toBe(false)
  })

  it("rejects ids with control characters or quotes", () => {
    expect(parseTrackingRequest(body("page_hit", { ...hit, plan_ids: "pv_1,pv'2" })).success).toBe(
      false
    )
    expect(
      parseTrackingRequest({
        ...body("plan_click", { plan_version_id: "pv_1", page_id: "p" }),
        session_id: "a\u0000b",
      }).success
    ).toBe(false)
  })

  it("rejects a page hit without its required fields and a payload that is not JSON", () => {
    expect(parseTrackingRequest(body("page_hit", { page_id: "page_1" })).success).toBe(false)
    expect(
      parseTrackingRequest({ action: "plan_click", session_id: "s", project_id: "p", payload: "{" })
    ).toEqual({ success: false, error: "Invalid payload JSON" })
  })
})
