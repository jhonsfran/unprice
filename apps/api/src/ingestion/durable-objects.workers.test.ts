import { reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { upsertBudgetInputSchema } from "@unprice/db/validators"
import { afterEach, describe, expect, it } from "vitest"
import {
  budgetNamespace,
  entitlementWindowNamespace,
  runBudgetNamespace,
} from "~/ingestion/do-placement"

afterEach(async () => {
  await reset()
})

describe("Durable Object workers runtime bindings", () => {
  it("binds EntitlementWindowDO inside workerd", async () => {
    const { EntitlementWindowDO } = await import("~/ingestion/entitlements/EntitlementWindowDO")
    const stub = entitlementWindowNamespace(env).getByName("test:workers:entitlementwindow:smoke")

    await runInDurableObject(stub, async (instance: EntitlementWindowDO, state) => {
      expect(instance).toBeInstanceOf(EntitlementWindowDO)
      // Bootstrapping arms the retention alarm: without one the window could
      // never collect its own storage.
      await expect(state.storage.getAlarm()).resolves.toEqual(expect.any(Number))
    })
  })

  it("binds RunBudgetDO inside workerd", async () => {
    const { RunBudgetDO } = await import("~/ingestion/run-budget/RunBudgetDO")
    const stub = runBudgetNamespace(env).getByName("test:workers:runbudget:smoke")

    await runInDurableObject(stub, async (instance: RunBudgetDO, state) => {
      expect(instance).toBeInstanceOf(RunBudgetDO)
      // Same invariant as the entitlement window: always an armed alarm.
      await expect(state.storage.getAlarm()).resolves.toEqual(expect.any(Number))
    })
  })

  it("binds BudgetDO inside workerd", async () => {
    const { BudgetDO } = await import("~/ingestion/budget/BudgetDO")
    const stub = budgetNamespace(env).getByName("test:workers:budget:smoke")
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
