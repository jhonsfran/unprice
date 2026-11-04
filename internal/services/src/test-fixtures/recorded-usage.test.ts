import type { Database } from "@unprice/db"
import { describe, expect, it, vi } from "vitest"
import { createRecordedUsageFixture } from "./recorded-usage"

const input = {
  projectId: "proj_fixture",
  customerId: "cus_fixture",
  subscriptionId: "sub_fixture",
  subscriptionPhaseId: "phase_fixture",
  statementKey: "stmt_fixture",
}

describe("explicit accepted usage fixture", () => {
  it("keeps accepted $10 independent of a $6 ledger capture and delayed reporting", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ amount: "6.00000000", metadata: { flow: "capture" } }],
    })
    const db = {
      execute,
      query: {
        billingPeriods: {
          findMany: vi.fn().mockResolvedValue([
            {
              ...input,
              id: "bp_fixture",
              subscriptionItemId: "item_fixture",
              cycleStartAt: 100,
              cycleEndAt: 200,
              subscriptionItem: {
                featurePlanVersion: { featureType: "usage", feature: { slug: "events" } },
              },
              subscriptionPhase: { creditLinePolicy: "capped", planVersion: { currency: "USD" } },
            },
          ]),
        },
        customerEntitlements: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: "ent_fixture", effectiveAt: 100, expiresAt: 200 }]),
        },
      },
    } as unknown as Database
    const { reservationFlushGateway } = createRecordedUsageFixture(db, {
      events: { amount: 1_000_000_000, quantity: 10 },
    })

    const result = await reservationFlushGateway.flushForInvoicing(input)

    expect(result.err).toBeUndefined()
    expect(result.val?.snapshots).toEqual([
      expect.objectContaining({ amount: 1_000_000_000, quantity: 10, state: "sealed" }),
    ])
    expect(execute).not.toHaveBeenCalled()
  })
})
