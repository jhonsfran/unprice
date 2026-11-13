import { initTRPC } from "@trpc/server"
import { Err, FetchError } from "@unprice/error"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Context } from "#trpc"

const { getWorkspaceBillingOverviewMock } = vi.hoisted(() => ({
  getWorkspaceBillingOverviewMock: vi.fn(),
}))

vi.mock("#utils/unprice", () => ({
  unprice: { access: { entitlements: { current: vi.fn() } } },
}))

vi.mock("#trpc", async () => {
  const { initTRPC } = await import("@trpc/server")
  return { protectedWorkspaceProcedure: initTRPC.create().procedure }
})
vi.mock("@unprice/services/use-cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@unprice/services/use-cases")>()),
  getWorkspaceBillingOverview: getWorkspaceBillingOverviewMock,
}))

import { getBillingOverview } from "./getBillingOverview"

const router = initTRPC.context<Context>().create().router({ getBillingOverview })

afterEach(() => vi.resetAllMocks())

describe("workspace billing overview adapter", () => {
  it("passes the journal and customer services and maps a read failure", async () => {
    const services = { customers: {}, wallet: {}, budgetJournal: {} }
    const workspace = { id: "ws_1", slug: "acme", unPriceCustomerId: "cus_1" }
    const db = {}
    const logger = { error: vi.fn() }
    const caller = router.createCaller({
      services,
      workspace,
      db,
      logger,
    } as unknown as Context)
    getWorkspaceBillingOverviewMock.mockResolvedValue(
      Err(new FetchError({ message: "billing read failed", retry: false }))
    )

    await expect(caller.getBillingOverview({ range: "30d" })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    })
    expect(getWorkspaceBillingOverviewMock).toHaveBeenCalledWith(
      { services, db, logger, currentEntitlements: expect.any(Function) },
      { workspace, range: "30d" }
    )
  })
})
