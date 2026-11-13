import { reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { upsertBudgetInputSchema } from "@unprice/db/validators"
import { afterEach, describe, expect, it } from "vitest"
import { getBudgetStub } from "~/ingestion/do-placement"

afterEach(async () => {
  await reset()
})

describe("Durable Object workers runtime bindings", () => {
  it("binds BudgetDO inside workerd", async () => {
    const { BudgetDO } = await import("~/ingestion/budget/BudgetDO")
    const stub = getBudgetStub(env, { projectId: "proj_1", key: "smoke" })
    const parsed = upsertBudgetInputSchema.parse({ key: "smoke", unit: "USD", limits: [] })
    const reply = await stub.execute({
      type: "upsert",
      projectId: "proj_1",
      ...parsed,
      mayLoosen: true,
    })

    expect(reply.ok).toBe(true)
    await runInDurableObject(stub, async (instance: InstanceType<typeof BudgetDO>, state) => {
      expect(instance).toBeInstanceOf(BudgetDO)
      // A budget wakes only for a row that is due, so one with no holds or charges sleeps.
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })
  })
})
