import { reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EntitlementWindowDO } from "./EntitlementWindowDO"
import { entitlementPeriodUsageTable, schema } from "./db/schema"
import { EntitlementWindowStore } from "./entitlement-window-store"
import { createGrantSnapshot } from "./entitlement-window-test-fixtures"

afterEach(async () => {
  await reset()
})

describe("EntitlementWindowStore SQLite reads", () => {
  it("reads only active period buckets when broad retained history exists", async () => {
    const stub = env.entitlementwindow.getByName("test:store:bounded-active-buckets")

    await runInDurableObject(stub, async (instance: EntitlementWindowDO, state) => {
      // Await constructor migrations before opening a second store over the same SQLite handle.
      await instance.getStatus()

      const logger = { warn: vi.fn() }
      const db = drizzle(state.storage, { schema, logger: false })
      const store = new EntitlementWindowStore(db, logger, () => {})
      const effectiveAt = Date.now() - 60_000
      const timestamp = effectiveAt + 1_000
      const periodKey = `onetime:${effectiveAt}`
      const grant = createGrantSnapshot({
        grantId: "grant_active",
        cadenceEffectiveAt: effectiveAt,
        cadenceExpiresAt: effectiveAt + 120_000,
        effectiveAt,
        expiresAt: effectiveAt + 120_000,
      })
      const activeState = {
        bucketKey: `grant_active:${periodKey}`,
        consumedInCurrentWindow: 2,
        exhaustedAt: null,
        grantId: "grant_active",
        periodEndAt: effectiveAt + 120_000,
        periodKey,
        periodStartAt: effectiveAt,
      }
      store.writeGrantConsumptions([activeState])

      // Invalid JSON makes an accidental broad scan observable through the warning logger.
      // A bounded lookup must not load or parse any of these retained historical rows.
      for (let index = 0; index < 100; index++) {
        db.insert(entitlementPeriodUsageTable)
          .values({
            periodKey: `historical:${index}`,
            periodStartAt: effectiveAt - (index + 2) * 60_000,
            periodEndAt: effectiveAt - (index + 1) * 60_000,
            grantStatesJson: "{historical-invalid-json",
            updatedAt: effectiveAt,
          })
          .run()
      }

      expect(store.readGrantStatesForActiveGrants([grant], timestamp)).toEqual([activeState])
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })
})
