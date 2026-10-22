import { upsertBudgetInputSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { inspect } from "./inspect"
import { MemoryBudgetStore } from "./memory-store.fixture"

const now = Date.parse("2026-10-20T12:00:00Z")
const amount = BigInt(100_000_000)

function budget(closesAt: number | null = null) {
  const store = new MemoryBudgetStore()
  const parsed = upsertBudgetInputSchema.parse({
    key: "customer:acme",
    unit: "USD",
    limits: [{ amount: "10", window: "never" }],
    closesAt,
  })
  store.run({ type: "upsert", projectId: "proj_1", ...parsed, mayLoosen: true }, now)
  return store
}

describe("budget admission", () => {
  it("refuses a stale operator release without changing the replacement hold", () => {
    const store = budget()
    store.run({ type: "authorize", idempotencyKey: "new-work", amount }, now)

    const result = store.run(
      { type: "release", holdId: "h_1", holdCreatedAt: now - 8 * 86_400_000 },
      now + 1
    )

    expect(result.err?.code).toBe("HOLD_NOT_FOUND")
    const hold = store.rows.get("h_1")
    expect(hold?.kind === "hold" && hold.state).toEqual({
      status: "open",
    })
    expect(store.ledger.held).toBe(amount)
  })

  it("replays the release of the exact hold", () => {
    const store = budget()
    store.run({ type: "authorize", idempotencyKey: "work", amount }, now)
    const command = { type: "release", holdId: "h_1", holdCreatedAt: now } as const

    store.run(command, now + 1)
    const replay = store.run(command, now + 2)

    expect(replay.val?.ok && replay.val.outcome).toMatchObject({
      type: "release",
      released: amount,
      replayed: true,
    })
  })

  it("gives a closed budget's probe the same rejection as authorization", () => {
    const store = budget(now - 1)
    const read = store.run({ type: "get" }, now)
    if (!read.val?.ok || read.val.outcome.type !== "get") throw new Error("No budget snapshot")
    const reader = {
      walkReservations: () => ({ rows: [], examined: 0, last: null }),
      readDueBetween: () => [],
      readOperation: () => null,
      readOperationByKey: () => null,
      readLease: () => null,
    }

    const probe = inspect(reader, read.val.outcome, { probe: amount }, now)
    const authorized = store.run({ type: "authorize", idempotencyKey: "work", amount }, now)

    expect(probe.probe).toEqual({
      amount,
      rejection: { code: "BUDGET_CLOSED", closedAt: now - 1 },
    })
    expect(probe.probe?.rejection).toEqual(authorized.err?.rejection)
  })
})
