import { describe, expect, it } from "vitest"
import { anchoredWindowBounds, windowBounds, windowIdOf, windowSpecOf } from "./windows"

const at = (iso: string) => Date.parse(iso)
const iso = ({ start, end }: { start: number; end: number | null }) => [
  new Date(start).toISOString(),
  end === null ? null : new Date(end).toISOString(),
]

describe("anchoredWindowBounds", () => {
  it.each([
    [
      "inside the anchor's own month",
      "2026-01-31T12:00:00Z",
      "2026-01-31T10:00:00.000Z",
      "2026-02-28T10:00:00.000Z",
    ],
    [
      "just before a short month's start",
      "2026-02-28T09:59:59.999Z",
      "2026-01-31T10:00:00.000Z",
      "2026-02-28T10:00:00.000Z",
    ],
    [
      "on the short month's start",
      "2026-02-28T10:00:00Z",
      "2026-02-28T10:00:00.000Z",
      "2026-03-31T10:00:00.000Z",
    ],
    [
      "in a 30-day month",
      "2026-05-01T00:00:00Z",
      "2026-04-30T10:00:00.000Z",
      "2026-05-31T10:00:00.000Z",
    ],
    [
      "in a leap February",
      "2028-02-29T11:00:00Z",
      "2028-02-29T10:00:00.000Z",
      "2028-03-31T10:00:00.000Z",
    ],
    [
      "before the anchor",
      "2025-12-01T00:00:00Z",
      "2025-11-30T10:00:00.000Z",
      "2025-12-31T10:00:00.000Z",
    ],
    [
      "across a year end",
      "2026-12-31T10:00:00Z",
      "2026-12-31T10:00:00.000Z",
      "2027-01-31T10:00:00.000Z",
    ],
  ])("anchors a month on the 31st %s", (_name, now, start, end) => {
    const bounds = anchoredWindowBounds("month", at("2026-01-31T10:00:00Z"), at(now))
    expect(iso(bounds)).toEqual([start, end])
  })

  it.each([
    ["2027-02-28T12:00:00Z", "2027-02-28T00:00:00.000Z", "2027-03-29T00:00:00.000Z"],
    ["2027-02-27T12:00:00Z", "2027-01-29T00:00:00.000Z", "2027-02-28T00:00:00.000Z"],
    ["2028-02-29T01:00:00Z", "2028-02-29T00:00:00.000Z", "2028-03-29T00:00:00.000Z"],
    ["2028-02-28T23:00:00Z", "2028-01-29T00:00:00.000Z", "2028-02-29T00:00:00.000Z"],
  ])("anchors a month on the 29th at %s", (now, start, end) => {
    const bounds = anchoredWindowBounds("month", at("2026-10-29T00:00:00Z"), at(now))
    expect(iso(bounds)).toEqual([start, end])
  })

  it.each([
    ["day", "2026-10-20T09:29:00Z", "2026-10-19T09:30:00.000Z", "2026-10-20T09:30:00.000Z"],
    ["day", "2026-10-20T09:30:00Z", "2026-10-20T09:30:00.000Z", "2026-10-21T09:30:00.000Z"],
    ["day", "2026-10-01T10:00:00Z", "2026-10-01T09:30:00.000Z", "2026-10-02T09:30:00.000Z"],
    ["week", "2026-10-21T23:00:00Z", "2026-10-15T09:30:00.000Z", "2026-10-22T09:30:00.000Z"],
    ["week", "2026-10-22T09:30:00Z", "2026-10-22T09:30:00.000Z", "2026-10-29T09:30:00.000Z"],
    ["week", "2026-10-08T09:29:59Z", "2026-10-01T09:30:00.000Z", "2026-10-08T09:30:00.000Z"],
  ] as const)("keeps a %s anchor's time and weekday at %s", (every, now, start, end) => {
    const bounds = anchoredWindowBounds(every, at("2026-10-15T09:30:00Z"), at(now))
    expect(iso(bounds)).toEqual([start, end])
  })
})

describe("window ids", () => {
  it.each([
    ["day", "1969-12-20T09:30:00.123Z", "day@1970-01-01T09:30:00.123Z"],
    ["week", "1969-12-18T09:30:00.123Z", "week@1970-01-01T09:30:00.123Z"],
    ["week", "1969-12-17T09:30:00.123Z", "week@1970-01-07T09:30:00.123Z"],
  ] as const)("normalizes a pre-epoch %s anchor", (window, anchor, expected) => {
    expect(windowIdOf({ window, anchor: at(anchor) })).toBe(expected)
    expect(windowBounds(windowSpecOf(expected), at("2026-10-15T09:30:00.123Z"))).toEqual(
      windowBounds({ window, anchor: at(anchor) }, at("2026-10-15T09:30:00.123Z"))
    )
  })

  it("names a calendar window by itself and an anchored one by its anchor", () => {
    const anchored = { window: "month", anchor: at("2026-10-15T00:00:00+02:00") } as const
    expect(windowIdOf({ window: "day" })).toBe("day")
    expect(windowIdOf(anchored)).toBe("month@1970-01-14T22:00:00.000Z")
    expect(windowSpecOf("month@2026-10-14T22:00:00.000Z")).toEqual(anchored)
    expect(windowSpecOf("week")).toEqual({ window: "week" })
    expect(() => windowIdOf({ window: "hour", anchor: 0 })).toThrow("hour cannot be anchored")
  })

  it("bounds a spec by its calendar window or by its anchor", () => {
    const now = at("2026-10-16T08:00:00Z")
    expect(iso(windowBounds({ window: "month" }, now))).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
    ])
    expect(iso(windowBounds({ window: "month", anchor: at("2026-10-15T00:00:00Z") }, now))).toEqual(
      ["2026-10-15T00:00:00.000Z", "2026-11-15T00:00:00.000Z"]
    )
    expect(iso(windowBounds({ window: "never" }, now))).toEqual(["1970-01-01T00:00:00.000Z", null])
  })
})
