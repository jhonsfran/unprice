import { reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"

afterEach(async () => {
  await reset()
})

describe("Durable Object workers runtime bindings", () => {
  it("binds EntitlementWindowDO inside workerd", async () => {
    const { EntitlementWindowDO } = await import("~/ingestion/entitlements/EntitlementWindowDO")
    const stub = env.entitlementwindow.getByName("test:workers:entitlementwindow:smoke")

    await runInDurableObject(stub, async (instance: EntitlementWindowDO, state) => {
      expect(instance).toBeInstanceOf(EntitlementWindowDO)
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })
  })

  it("binds RunBudgetDO inside workerd", async () => {
    const { RunBudgetDO } = await import("~/ingestion/run-budget/RunBudgetDO")
    const stub = env.runbudget.getByName("test:workers:runbudget:smoke")

    await runInDurableObject(stub, async (instance: RunBudgetDO, state) => {
      expect(instance).toBeInstanceOf(RunBudgetDO)
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })
  })
})
