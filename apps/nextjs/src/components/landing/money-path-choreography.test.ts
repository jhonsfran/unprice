import { describe, expect, it } from "vitest"
import {
  MONEY_PATH_PASS_PLAN,
  type MoneyPathElementSnapshot,
  type MoneyPathWaypointId,
  buildMoneyPathPass,
} from "./money-path-choreography"

function element(left: number, top: number, width = 10, height = 10): HTMLElement {
  return {
    getBoundingClientRect: () =>
      ({
        bottom: top + height,
        height,
        left,
        right: left + width,
        top,
        width,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect,
  } as HTMLElement
}

function emptyElements(): Record<MoneyPathWaypointId, HTMLElement | null> {
  return {
    request: null,
    meter: null,
    access: null,
    "pricing-rule": null,
    price: null,
    decision: null,
    "allow-chip": null,
    "deny-chip": null,
    wallet: null,
    ledger: null,
    invoice: null,
    payment: null,
  }
}

function compactElements(): MoneyPathElementSnapshot {
  const waypoints = emptyElements()
  const railDots = emptyElements()
  waypoints.request = element(8, 10)
  waypoints.price = element(8, 50)
  waypoints.decision = element(8, 90)
  waypoints["allow-chip"] = element(8, 140, 120, 40)
  waypoints["deny-chip"] = element(160, 140, 120, 40)
  railDots.request = element(4, 10)
  railDots.price = element(4, 50)
  railDots.decision = element(4, 90)

  return {
    root: element(0, 0, 300, 220),
    connector: null,
    waypoints,
    railDots,
  }
}

describe("money path choreography", () => {
  it("builds the compact allow pass from typed waypoint elements", () => {
    const elements = compactElements()
    const built = buildMoneyPathPass(elements, MONEY_PATH_PASS_PLAN[0]!, [
      { id: "price", label: "Price", fact: "$4.10" },
    ])

    expect(built?.duration).toBeGreaterThan(0)
    expect(built?.keyframes.length).toBeGreaterThan(0)
    expect(built?.sets.map((set) => set.value)).toEqual([10, 5.9])
    expect(built?.hits.map((hit) => hit.el)).toEqual([
      elements.waypoints.request,
      elements.waypoints.price,
      elements.waypoints.decision,
      elements.waypoints["allow-chip"],
    ])
  })

  it("does not build a pass when a required waypoint is absent", () => {
    const elements = compactElements()
    elements.waypoints.decision = null

    expect(buildMoneyPathPass(elements, MONEY_PATH_PASS_PLAN[0]!, [])).toBeNull()
  })
})
