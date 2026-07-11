import { reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { afterEach, describe, expect, it } from "vitest"
import type { RunBudgetDO } from "./RunBudgetDO"
import * as schema from "./db/schema"
import type { RunSpendBucketDelta, RunState } from "./ports"
import { RunBudgetStore } from "./run-budget-store"
import { RUN_BUDGET_TEST_NOW } from "./testing/harness"

function createRun(runId: string): RunState {
  return {
    runId,
    projectId: "proj_1",
    customerId: "cus_1",
    workloadType: "agent",
    workloadId: "agent_1",
    traceId: null,
    parentRunId: null,
    reservationId: "res_1",
    status: "running",
    currency: "USD",
    budgetAmount: 20_000,
    reservedAmount: 20_000,
    consumedAmount: 0,
    flushedAmount: 0,
    lastCaptureSeq: 0,
    startedAt: RUN_BUDGET_TEST_NOW,
    endedAt: null,
    expiresAt: null,
    lastEventAt: null,
    metadataJson: "{}",
    reconciliationNeeded: false,
  }
}

function createDelta(runId: string, amount = 5_000): RunSpendBucketDelta {
  return {
    amount,
    billingPeriodId: "bp_1",
    bucketKey: `${runId}:ce_1:stmt_1:period_1`,
    currency: "USD",
    entitlementId: "ce_1",
    featureId: null,
    featurePlanVersionItemId: "item_1",
    featureSlug: "tokens",
    periodEndAt: RUN_BUDGET_TEST_NOW + 60_000,
    periodStartAt: RUN_BUDGET_TEST_NOW - 60_000,
    quantity: 5,
    statementKey: "stmt_1",
  }
}

async function seedSpend(
  store: RunBudgetStore,
  run: RunState,
  delta: RunSpendBucketDelta
): Promise<void> {
  await store.createRun(run)
  await store.commitSpendAndIdempotency({
    run,
    updatedRun: { ...run, consumedAmount: delta.amount, lastEventAt: RUN_BUDGET_TEST_NOW },
    idempotencyKey: `idem:${run.runId}`,
    decision: {
      allowed: true,
      state: "processed",
      budget: {
        runId: run.runId,
        status: "running",
        budgetAmount: run.budgetAmount,
        consumedAmount: delta.amount,
        remainingAmount: run.budgetAmount - delta.amount,
      },
      meterFacts: [],
    },
    pricedAmount: delta.amount,
    bucketDeltas: [delta],
    createdAt: RUN_BUDGET_TEST_NOW,
  })
}

afterEach(async () => {
  await reset()
})

describe("RunBudgetStore real SQLite transactions", () => {
  it("rolls back intent and bucket updates when capture success fails after the bucket write", async () => {
    const stub = env.runbudget.getByName(`test:run-budget-store:${crypto.randomUUID()}`)
    await runInDurableObject(stub, async (instance: RunBudgetDO, state) => {
      await instance
        .getRunStatus({ runId: "__bootstrap__", customerId: "cus_1", projectId: "proj_1" })
        .catch(() => undefined)
      const db = drizzle(state.storage, { schema, logger: false })
      const store = new RunBudgetStore(db)
      const run = createRun("run_atomic_capture")
      const delta = createDelta(run.runId)
      await seedSpend(store, run, delta)
      const intent = await store.openCaptureIntent({
        runId: run.runId,
        bucketKey: delta.bucketKey,
        now: RUN_BUDGET_TEST_NOW,
      })
      expect(intent).not.toBeNull()

      state.storage.sql.exec(`
        CREATE TRIGGER fail_run_capture_success
        BEFORE UPDATE OF flushed_amount ON run_state
        BEGIN
          SELECT RAISE(ABORT, 'fail after bucket write');
        END
      `)
      const commit = {
        intentKey: intent?.intentKey ?? "missing",
        bucketKey: delta.bucketKey,
        runId: run.runId,
        amount: 5_000,
        updatedAt: RUN_BUDGET_TEST_NOW + 1,
      }
      await expect(store.commitCaptureSuccess(commit)).rejects.toThrow("fail after bucket write")

      await expect(store.loadRun(run.runId)).resolves.toMatchObject({ flushedAmount: 0 })
      await expect(store.loadCaptureIntent(commit.intentKey)).resolves.toMatchObject({
        status: "pending",
      })
      await expect(
        db.query.runSpendBuckets.findFirst({
          where: eq(schema.runSpendBuckets.bucketKey, delta.bucketKey),
        })
      ).resolves.toMatchObject({ flushedAmount: 0 })

      state.storage.sql.exec("DROP TRIGGER fail_run_capture_success")
      await store.commitCaptureSuccess(commit)
      await expect(store.loadRun(run.runId)).resolves.toMatchObject({ flushedAmount: 5_000 })
      await expect(store.loadCaptureIntent(commit.intentKey)).resolves.toMatchObject({
        status: "captured",
      })
      await expect(
        db.query.runSpendBuckets.findFirst({
          where: eq(schema.runSpendBuckets.bucketKey, delta.bucketKey),
        })
      ).resolves.toMatchObject({ flushedAmount: 5_000 })
    })
  })

  it("allocates the run sequence and capture range in one transaction", async () => {
    const stub = env.runbudget.getByName(`test:run-budget-allocation:${crypto.randomUUID()}`)
    await runInDurableObject(stub, async (instance: RunBudgetDO, state) => {
      await instance
        .getRunStatus({ runId: "__bootstrap__", customerId: "cus_1", projectId: "proj_1" })
        .catch(() => undefined)
      const db = drizzle(state.storage, { schema, logger: false })
      const store = new RunBudgetStore(db)
      const run = createRun("run_atomic_allocation")
      const delta = createDelta(run.runId)
      await seedSpend(store, run, delta)

      state.storage.sql.exec(`
        CREATE TRIGGER fail_run_capture_allocation
        BEFORE INSERT ON run_capture_intents
        BEGIN
          SELECT RAISE(ABORT, 'fail after sequence allocation');
        END
      `)
      await expect(
        store.openCaptureIntent({
          runId: run.runId,
          bucketKey: delta.bucketKey,
          now: RUN_BUDGET_TEST_NOW,
        })
      ).rejects.toThrow("fail after sequence allocation")

      await expect(store.loadRun(run.runId)).resolves.toMatchObject({ lastCaptureSeq: 0 })
      await expect(
        store.loadCaptureIntent(`run-capture:${run.runId}:${delta.bucketKey}:0`)
      ).resolves.toBeUndefined()

      state.storage.sql.exec("DROP TRIGGER fail_run_capture_allocation")
      await expect(
        store.openCaptureIntent({
          runId: run.runId,
          bucketKey: delta.bucketKey,
          now: RUN_BUDGET_TEST_NOW,
        })
      ).resolves.toMatchObject({
        amount: 5_000,
        flushSeq: RUN_BUDGET_TEST_NOW,
        rangeStartAmount: 0,
        targetAmount: 5_000,
      })
      await expect(store.loadRun(run.runId)).resolves.toMatchObject({
        lastCaptureSeq: RUN_BUDGET_TEST_NOW,
      })
    })
  })

  it("derives range and sequence values for capture intents created before the migration", async () => {
    const stub = env.runbudget.getByName(`test:run-budget-legacy-range:${crypto.randomUUID()}`)
    await runInDurableObject(stub, async (instance: RunBudgetDO, state) => {
      await instance
        .getRunStatus({ runId: "__bootstrap__", customerId: "cus_1", projectId: "proj_1" })
        .catch(() => undefined)
      const db = drizzle(state.storage, { schema, logger: false })
      const store = new RunBudgetStore(db)
      const run = createRun("run_legacy_capture")
      const delta = createDelta(run.runId, 10_000)
      await seedSpend(store, run, delta)

      const legacyIntentKey = `run-capture:${run.runId}:${delta.bucketKey}:0`
      await db.insert(schema.runCaptureIntents).values({
        intentKey: legacyIntentKey,
        runId: run.runId,
        bucketKey: delta.bucketKey,
        amount: 5_000,
        status: "abandoned",
        attemptCount: 5,
        lastError: "wallet unavailable",
        createdAt: RUN_BUDGET_TEST_NOW,
        updatedAt: RUN_BUDGET_TEST_NOW,
      })

      await expect(store.loadCaptureIntent(legacyIntentKey)).resolves.toMatchObject({
        flushSeq: 0,
        rangeStartAmount: 0,
        targetAmount: 0,
      })
      await expect(
        store.openCaptureIntent({
          runId: run.runId,
          bucketKey: delta.bucketKey,
          now: RUN_BUDGET_TEST_NOW,
        })
      ).resolves.toMatchObject({
        amount: 5_000,
        flushSeq: RUN_BUDGET_TEST_NOW + 1,
        rangeStartAmount: 5_000,
        targetAmount: 10_000,
      })
    })
  })
})
