import { describe, expect, it } from "vitest"
import { explainDenial } from "./explain-denial"

describe("explainDenial", () => {
  it("names the limit, its room and holds, the reset, and the advice for the remedy", () => {
    const daily = {
      limitId: "daily",
      window: "day" as const,
      remaining: "61.2",
      held: "12.4",
      resetsAt: Date.UTC(2026, 9, 20),
    }

    expect([
      explainDenial({ ...daily, remedy: "release_holds" }, "money:USD"),
      explainDenial({ ...daily, remedy: "wait_for_reset" }, "money:USD"),
    ]).toEqual([
      "Denied by daily (hard, day): 61.20 left with 12.40 held. Resets Oct 20, 00:00 UTC. Release stuck holds or raise the limit.",
      "Denied by daily (hard, day): 61.20 left with 12.40 held. Resets Oct 20, 00:00 UTC. Wait for the reset or raise the limit.",
    ])
  })

  it("reads an overrun lifetime limit in plain units", () => {
    expect(
      explainDenial(
        {
          limitId: "total",
          window: "never",
          remaining: "-1500",
          held: "0",
          resetsAt: null,
          remedy: "raise_limit",
        },
        "units:tokens"
      )
    ).toBe(
      "Denied by total (hard, never): over by 1,500 with 0 held. It never resets. Releasing holds or waiting for the reset is not enough. Raise the limit."
    )
  })
})
