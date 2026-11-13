import { describe, expect, it } from "vitest"
import { toEventFormValues } from "./event-dialog"
import { aggregationFieldFor, meterDefaultsFor } from "./meter-defaults"

describe("meterDefaultsFor", () => {
  it("counts an event that carries no numeric property", () => {
    expect(meterDefaultsFor({ availableProperties: [] }, {})).toEqual({
      aggregationMethod: "count",
    })
    expect(
      meterDefaultsFor(
        { availableProperties: null },
        { aggregationMethod: "sum", aggregationField: "value" }
      )
    ).toEqual({ aggregationMethod: "count" })
  })

  it("sums the first property of a new meter whose event carries numbers", () => {
    expect(
      meterDefaultsFor({ availableProperties: ["input_tokens", "output_tokens"] }, {})
    ).toEqual({ aggregationMethod: "sum", aggregationField: "input_tokens" })
  })

  it("keeps a chosen method and a property the event still carries", () => {
    expect(
      meterDefaultsFor(
        { availableProperties: ["input_tokens", "output_tokens"] },
        { aggregationMethod: "sum", aggregationField: "output_tokens" }
      )
    ).toEqual({ aggregationMethod: "sum", aggregationField: "output_tokens" })
    expect(
      meterDefaultsFor(
        { availableProperties: ["input_tokens"] },
        { aggregationMethod: "sum", aggregationField: "value" }
      )
    ).toEqual({ aggregationMethod: "sum", aggregationField: "input_tokens" })
    expect(
      meterDefaultsFor({ availableProperties: ["input_tokens"] }, { aggregationMethod: "count" })
    ).toEqual({ aggregationMethod: "count" })
  })
})

describe("aggregationFieldFor", () => {
  it("has no field for a count, and the first property when the current one is gone", () => {
    expect(aggregationFieldFor(["a", "b"], "count", "a")).toBeUndefined()
    expect(aggregationFieldFor([], "sum", "a")).toBeUndefined()
    expect(aggregationFieldFor(["a", "b"], "sum", "b")).toBe("b")
    expect(aggregationFieldFor(["a", "b"], "sum", "c")).toBe("a")
    expect(aggregationFieldFor(["a", "b"], "sum")).toBe("a")
  })
})

describe("toEventFormValues", () => {
  it("opens the Create event dialog with no property row", () => {
    expect(toEventFormValues()).toEqual({ name: "", slug: "", availableProperties: [] })
  })

  it("lists an existing event's properties for editing", () => {
    expect(
      toEventFormValues({ name: "Tokens", slug: "tokens", availableProperties: ["input_tokens"] })
    ).toEqual({ name: "Tokens", slug: "tokens", availableProperties: [{ value: "input_tokens" }] })
  })
})
