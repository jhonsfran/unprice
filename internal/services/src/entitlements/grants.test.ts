import { describe, expect, it } from "vitest"
import { DEFAULT_GRANT_PRIORITY, GrantsManager } from "./grants"

describe("GrantsManager lean grant model", () => {
  const logger = {
    error: () => undefined,
  }

  it("keeps deterministic priorities by grant source", () => {
    expect(DEFAULT_GRANT_PRIORITY).toEqual({
      subscription: 10,
      addon: 50,
      trial: 80,
      promotion: 90,
      manual: 100,
    })
  })

  it("returns the default priority for top-up, trial, promo, and subscription chunks", () => {
    const manager = new GrantsManager({
      db: {} as never,
      logger: logger as never,
    })

    expect(manager.getDefaultPriority("subscription")).toBe(10)
    expect(manager.getDefaultPriority("trial")).toBe(80)
    expect(manager.getDefaultPriority("promotion")).toBe(90)
    expect(manager.getDefaultPriority("manual")).toBe(100)
  })
})
