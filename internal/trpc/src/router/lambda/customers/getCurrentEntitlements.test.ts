import { initTRPC } from "@trpc/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Context } from "#trpc"

const sdk = vi.hoisted(() => ({ current: vi.fn() }))

vi.mock("#trpc", async () => {
  const { initTRPC } = await import("@trpc/server")
  return { protectedProjectProcedure: initTRPC.create().procedure }
})
vi.mock("#utils/unprice", () => ({
  unprice: { access: { entitlements: sdk } },
}))

import { getCurrentEntitlements } from "./getCurrentEntitlements"

const router = initTRPC.context<Context>().create().router({ getCurrentEntitlements })
const caller = router.createCaller({
  project: { id: "proj_123" },
  logger: { error: vi.fn() },
} as unknown as Context)

beforeEach(() => vi.clearAllMocks())

describe("getCurrentEntitlements", () => {
  it.each([
    ["BAD_REQUEST", "BAD_REQUEST"],
    ["UNAUTHORIZED", "UNAUTHORIZED"],
    ["FORBIDDEN", "FORBIDDEN"],
    ["INSUFFICIENT_PERMISSIONS", "FORBIDDEN"],
    ["DISABLED", "FORBIDDEN"],
    ["USAGE_EXCEEDED", "FORBIDDEN"],
    ["EXPIRED", "FORBIDDEN"],
    ["NOT_FOUND", "NOT_FOUND"],
    ["CONFLICT", "CONFLICT"],
    ["PRECONDITION_FAILED", "PRECONDITION_FAILED"],
    ["DELETE_PROTECTED", "PRECONDITION_FAILED"],
    ["PAYLOAD_TOO_LARGE", "PAYLOAD_TOO_LARGE"],
    ["METHOD_NOT_ALLOWED", "METHOD_NOT_SUPPORTED"],
    ["RATE_LIMITED", "TOO_MANY_REQUESTS"],
    ["TOO_MANY_REQUESTS", "TOO_MANY_REQUESTS"],
    ["INTERNAL_SERVER_ERROR", "INTERNAL_SERVER_ERROR"],
    ["UNKNOWN", "INTERNAL_SERVER_ERROR"],
  ])("maps SDK error %s to %s", async (apiCode, trpcCode) => {
    sdk.current.mockResolvedValue({ error: { code: apiCode, message: "Request failed" } })

    await expect(caller.getCurrentEntitlements({ customerId: "cus_123" })).rejects.toMatchObject({
      code: trpcCode,
      message: "Request failed",
    })
  })

  it("returns the snapshot from the SDK with the authorized project", async () => {
    const result = { customerId: "cus_123", generatedAt: 1, entitlements: [] }
    sdk.current.mockResolvedValue({ result })

    await expect(caller.getCurrentEntitlements({ customerId: "cus_123" })).resolves.toEqual(result)
    expect(sdk.current).toHaveBeenCalledWith({ customerId: "cus_123", projectId: "proj_123" })
  })

  it("leaves unexpected SDK exceptions as the original cause", async () => {
    const error = new TypeError("Invalid SDK state")
    sdk.current.mockRejectedValue(error)

    await expect(caller.getCurrentEntitlements({ customerId: "cus_123" })).rejects.toMatchObject({
      cause: error,
    })
  })
})
