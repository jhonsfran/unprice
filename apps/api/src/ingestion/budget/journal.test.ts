import { amountUsage } from "@unprice/services/budgets"
import { describe, expect, it } from "vitest"
import { journalRowOf } from "./journal"

describe("budget journal amounts", () => {
  it.each(["money:USD", "money:EUR"])("exports the budget's %s unit beside its amounts", (unit) => {
    const row = journalRowOf(
      { projectId: "proj_1", key: "unprice:customer:cus_1", unit },
      {
        seq: 1,
        writtenAt: 1_792_000_000_000,
        storedId: "o:1",
        status: "done",
        operation: {
          kind: "charge",
          id: "o:1",
          idempotencyKey: "event_1",
          usage: amountUsage(BigInt(150_000_000)),
          createdAt: 1_792_000_000_000,
          crossed: [],
        },
      }
    )

    expect(row.data).toMatchObject({ unit, usage: { amount: "1.5" } })
  })
})
