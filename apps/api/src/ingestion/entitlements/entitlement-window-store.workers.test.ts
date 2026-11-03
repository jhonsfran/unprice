import { reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { addBillingUsage, registerBillingUsage } from "@unprice/services/billing"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { entitlementWindowNamespace } from "~/ingestion/do-placement"
import type { EntitlementWindowDO } from "./EntitlementWindowDO"
import { entitlementPeriodUsageTable, idempotencyKeyBatchesTable, schema } from "./db/schema"
import { EntitlementWindowStore } from "./entitlement-window-store"
import { createApplyInput, createGrantSnapshot } from "./entitlement-window-test-fixtures"
import { createEntitlementWindowProcessorHarness } from "./testing/processor-contract"

afterEach(async () => {
  await reset()
})

describe("EntitlementWindowStore SQLite reads", () => {
  it("reads only active period buckets when broad retained history exists", async () => {
    const stub = entitlementWindowNamespace(env).getByName("test:store:bounded-active-buckets")

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

  it("reads the newest write as the retention anchor", async () => {
    const stub = entitlementWindowNamespace(env).getByName("test:store:last-activity")

    await runInDurableObject(stub, async (instance: EntitlementWindowDO, state) => {
      await instance.getStatus()

      const db = drizzle(state.storage, { schema, logger: false })
      const store = new EntitlementWindowStore(db, { warn: vi.fn() }, () => {})

      expect(store.readRetentionState()).toEqual({
        lifecycleEndAt: null,
        lastActivityAt: null,
        retentionAnchorAt: null,
      })

      const createdAt = Date.now()
      store.ensureMeterState({ meterKey: "meter_1", createdAt })
      expect(store.readRetentionState()).toEqual({
        lifecycleEndAt: null,
        lastActivityAt: createdAt,
        retentionAnchorAt: createdAt,
      })

      db.insert(entitlementPeriodUsageTable)
        .values({
          periodKey: "period_1",
          periodStartAt: createdAt - 5_000,
          periodEndAt: createdAt + 1_000,
          grantStatesJson: "[]",
          updatedAt: createdAt,
        })
        .run()

      db.insert(idempotencyKeyBatchesTable)
        .values({ createdAt: createdAt + 5_000, entries: "[]" })
        .run()
      expect(store.readRetentionState()).toEqual({
        lifecycleEndAt: createdAt + 1_000,
        lastActivityAt: createdAt + 5_000,
        retentionAnchorAt: createdAt + 5_000,
      })
    })
  })
  it("commits billing totals and accepted receipts atomically in SQLite", async () => {
    const stub = entitlementWindowNamespace(env).getByName("test:store:billing-atomicity")
    await runInDurableObject(stub, async (instance: EntitlementWindowDO, state) => {
      await instance.getStatus()
      const store = new EntitlementWindowStore(
        drizzle(state.storage, { schema, logger: false }),
        { warn: vi.fn() },
        () => {}
      )
      const now = Date.now()
      const snapshot = registerBillingUsage({
        projectId: "proj_test",
        customerId: "cus_test",
        customerEntitlementId: "ce_test",
        subscriptionId: "sub_test",
        subscriptionPhaseId: "phase_test",
        subscriptionItemId: "item_test",
        billingPeriodId: "bp_test",
        statementKey: "statement_test",
        featureSlug: "api_calls",
        cycleStartAt: now - 1_000,
        cycleEndAt: now + 60_000,
        currency: "USD",
        amountScale: 8,
        origin: "period_generation_v1",
        registeredAt: now,
      })
      store.writeBillingUsageSnapshot(snapshot)
      const next = addBillingUsage(snapshot, {
        amount: 100_000_000,
        quantity: 2,
        timestamp: now,
        currency: "USD",
        amountScale: 8,
      })
      const receipt = {
        eventId: "event_test",
        createdAt: now,
        allowed: true,
        deniedReason: null,
        denyMessage: null,
        meterFacts: [],
      }
      expect(() =>
        store.atomically((tx) => {
          tx.writeBillingUsageSnapshot(next)
          tx.writeBatchIdempotencyResults([receipt])
          throw new Error("abort")
        })
      ).toThrow("abort")
      expect(store.readBillingUsageSnapshot("bp_test")).toMatchObject({ amount: 0, quantity: 0 })
      expect(store.lookupCachedIdempotencyResult("event_test")).toBeNull()
      store.atomically((tx) => {
        tx.writeBillingUsageSnapshot(next)
        tx.writeBatchIdempotencyResults([receipt])
      })
      expect(store.readBillingUsageSnapshot("bp_test")).toMatchObject({
        amount: 100_000_000,
        quantity: 2,
      })
      const reopened = new EntitlementWindowStore(
        drizzle(state.storage, { schema, logger: false }),
        { warn: vi.fn() },
        () => {}
      )
      expect(reopened.readBillingUsageSnapshot("bp_test")).toMatchObject({
        amount: 100_000_000,
        quantity: 2,
      })
      expect(reopened.lookupCachedIdempotencyResult("event_test")).toMatchObject({ allowed: true })
    })
  })

  it("retries external-run usage after SQLite rolls back an already cached receipt", async () => {
    const stub = entitlementWindowNamespace(env).getByName("test:store:billing-cache-rollback")
    await runInDurableObject(stub, async (instance: EntitlementWindowDO, state) => {
      await instance.getStatus()
      const store = new EntitlementWindowStore(
        drizzle(state.storage, { schema, logger: false }),
        { warn: vi.fn() },
        () => {}
      )
      const now = Date.now()
      const base = createApplyInput({
        now,
        periodStartAt: now - 60_000,
        periodEndAt: now + 60_000,
        event: { timestamp: now },
      })
      const input = {
        ...base,
        entitlement: { ...base.entitlement, subscriptionId: "sub_123" },
        wallet: { mode: "external_reservation" as const, remainingAmount: 1_000_000_000 },
      }
      const period = input.entitlement.billingPeriods[0]!
      const harness = createEntitlementWindowProcessorHarness({ now, store })
      await harness.processor.registerBillingPeriods([
        {
          projectId: input.projectId,
          customerId: input.customerId,
          customerEntitlementId: input.entitlement.customerEntitlementId,
          subscriptionId: "sub_123",
          subscriptionPhaseId: "phase_123",
          subscriptionItemId: "item_123",
          billingPeriodId: period.billingPeriodId,
          statementKey: period.statementKey,
          featureSlug: input.entitlement.featureSlug,
          cycleStartAt: period.cycleStartAt,
          cycleEndAt: period.cycleEndAt,
          currency: "USD",
          amountScale: 8,
          origin: "period_generation_v1",
          registeredAt: now,
        },
      ])
      await Promise.all(harness.waitUntilPromises)
      const snapshot = store.readBillingUsageSnapshot(period.billingPeriodId)!
      expect(() =>
        store.atomically((tx) => {
          tx.writeBillingUsageSnapshot(
            addBillingUsage(snapshot, {
              amount: 100_000_000,
              quantity: 1,
              currency: "USD",
              amountScale: 8,
              timestamp: now,
            })
          )
          const receipt = {
            eventId: input.idempotencyKey,
            createdAt: now,
            allowed: true,
            deniedReason: null,
            denyMessage: null,
            meterFacts: [],
          }
          tx.writeBatchIdempotencyResults([receipt])
          store.recordBatchIdempotencyResults([receipt])
          throw new Error("abort before accepted transaction commits")
        })
      ).toThrow("abort before accepted transaction commits")
      expect(store.lookupCachedIdempotencyResult(input.idempotencyKey)).toBeNull()
      expect(store.readBillingUsageSnapshot(period.billingPeriodId)).toMatchObject({
        amount: 0,
        quantity: 0,
      })

      const accepted = await harness.processor.apply(input)
      expect(accepted.allowed).toBe(true)
      expect(accepted.meterFacts?.map((fact) => [fact.amount, fact.delta])).toEqual([
        [100_000_000, 1],
      ])
      expect(store.readBillingUsageSnapshot(period.billingPeriodId)).toMatchObject({
        amount: 100_000_000,
        quantity: 1,
      })
      expect(store.lookupCachedIdempotencyResult(input.idempotencyKey)).toMatchObject({
        allowed: true,
      })
    })
  })

  it("persists a seal across store reopen and rejects new usage without a receipt", async () => {
    const stub = entitlementWindowNamespace(env).getByName("test:store:billing-seal")
    await runInDurableObject(stub, async (instance: EntitlementWindowDO, state) => {
      await instance.getStatus()
      const now = Date.now()
      const base = createApplyInput({
        now,
        periodStartAt: now - 60_000,
        periodEndAt: now + 60_000,
        event: { timestamp: now },
      })
      const input = { ...base, entitlement: { ...base.entitlement, subscriptionId: "sub_123" } }
      const period = input.entitlement.billingPeriods[0]!
      const registration = {
        projectId: input.projectId,
        customerId: input.customerId,
        customerEntitlementId: input.entitlement.customerEntitlementId,
        subscriptionId: "sub_123",
        subscriptionPhaseId: "phase_123",
        subscriptionItemId: "item_123",
        billingPeriodId: period.billingPeriodId,
        statementKey: period.statementKey,
        featureSlug: input.entitlement.featureSlug,
        cycleStartAt: period.cycleStartAt,
        cycleEndAt: period.cycleEndAt,
        currency: "USD" as const,
        amountScale: 8 as const,
        origin: "period_generation_v1" as const,
        registeredAt: now,
      }
      await instance.registerBillingPeriods([registration])
      expect((await instance.apply(input)).allowed).toBe(true)
      await instance.sealBillingPeriods([registration])
      const reopened = new EntitlementWindowStore(
        drizzle(state.storage, { schema, logger: false }),
        { warn: vi.fn() },
        () => {}
      )
      expect(reopened.readBillingUsageSnapshot("bp_123")).toMatchObject({
        amount: 100_000_000,
        quantity: 1,
        state: "sealed",
      })
      await expect(
        instance.apply({
          ...input,
          idempotencyKey: "fresh",
          event: { ...input.event, id: "fresh" },
        })
      ).rejects.toThrow("sealed")
      expect(reopened.lookupCachedIdempotencyResult("fresh")).toBeNull()
      expect((await instance.apply(input)).allowed).toBe(true)
      expect(reopened.readBillingUsageSnapshot("bp_123")).toMatchObject({
        amount: 100_000_000,
        quantity: 1,
      })
    })
  })
})
