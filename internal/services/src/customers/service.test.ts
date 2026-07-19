import { describe, expect, it, vi } from "vitest"
import { CustomerService } from "./service"

function createService({
  existingMetadata,
  cachedAcl,
}: {
  existingMetadata: Record<string, unknown> | null
  cachedAcl: Record<string, unknown> | null
}) {
  const limit = vi.fn().mockResolvedValue([{ metadata: existingMetadata }])
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })

  const updateWhere = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn().mockReturnValue({ where: updateWhere })
  const update = vi.fn().mockReturnValue({ set })

  const cache = {
    accessControlList: {
      get: vi.fn().mockResolvedValue({ val: cachedAcl }),
      set: vi.fn(),
      remove: vi.fn(),
    },
  }

  const service = new CustomerService({
    db: { select, update } as never,
    logger: { error: vi.fn(), warn: vi.fn() } as never,
    analytics: {} as never,
    waitUntil: vi.fn(),
    cache: cache as never,
    metrics: {} as never,
    paymentProviderResolver: {} as never,
  })

  return { service, select, update, set, cache }
}

describe("CustomerService.updateAccessControlList", () => {
  it("persists the usage-limit flag into customer metadata so rebuilds keep it", async () => {
    const { service, update, set, cache } = createService({
      existingMetadata: { country: "CO" },
      cachedAcl: {
        customerUsageLimitReached: false,
        customerDisabled: false,
        subscriptionStatus: "active",
      },
    })

    await service.updateAccessControlList({
      customerId: "cus_123",
      projectId: "proj_123",
      updates: { customerUsageLimitReached: true },
    })

    expect(update).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({
      metadata: { country: "CO", usageLimitReached: true },
    })
    expect(cache.accessControlList.set).toHaveBeenCalledWith("proj_123:cus_123", {
      customerUsageLimitReached: true,
      customerDisabled: false,
      subscriptionStatus: "active",
    })
  })

  it("does not touch the customer row for cache-only updates", async () => {
    const { service, update } = createService({
      existingMetadata: null,
      cachedAcl: null,
    })

    await service.updateAccessControlList({
      customerId: "cus_123",
      projectId: "proj_123",
      updates: { subscriptionStatus: "canceled" },
    })

    expect(update).not.toHaveBeenCalled()
  })
})
