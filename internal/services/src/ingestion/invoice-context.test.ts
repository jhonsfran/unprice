import { describe, expect, it, vi } from "vitest"
import { catchUpAndReloadContext } from "./invoice-context"

const params = {
  candidateEntitlements: [],
  customerId: "cus_1",
  messages: [],
  projectId: "proj_1",
}

describe("catchUpAndReloadContext", () => {
  it("returns the current context untouched when no catch-up service is wired", async () => {
    const reload = vi.fn()
    const result = await catchUpAndReloadContext({
      ...params,
      catchUp: undefined,
      current: "original",
      reload,
    })
    expect(result).toEqual({ changed: false, context: "original" })
    expect(reload).not.toHaveBeenCalled()
  })

  it("returns the current context when catch-up changed nothing", async () => {
    const reload = vi.fn()
    const result = await catchUpAndReloadContext({
      ...params,
      catchUp: {
        catchUpForPreparedGroup: vi
          .fn()
          .mockResolvedValue({ changed: false, caughtUpSubscriptionIds: [] }),
      },
      current: "original",
      reload,
    })
    expect(result).toEqual({ changed: false, context: "original" })
    expect(reload).not.toHaveBeenCalled()
  })

  it("reloads after a catch-up changed subscription state", async () => {
    const result = await catchUpAndReloadContext({
      ...params,
      catchUp: {
        catchUpForPreparedGroup: vi
          .fn()
          .mockResolvedValue({ changed: true, caughtUpSubscriptionIds: ["sub_1"] }),
      },
      current: "original",
      reload: vi.fn().mockResolvedValue("refreshed"),
    })
    expect(result).toEqual({ changed: true, context: "refreshed" })
  })
})
