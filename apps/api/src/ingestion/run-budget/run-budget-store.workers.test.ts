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
      const run = {
        runId: "run_atomic_capture",
        projectId: "proj_1",
        customerId: "cus_1",
        workloadType: "agent",
        workloadId: "agent_1",
        traceId: null,
        parentRunId: null,
        reservationId: "res_1",
        status: "running",
        currency: "USD",
        budgetAmount: 10_000,
        reservedAmount: 10_000,
        consumedAmount: 0,
        flushedAmount: 0,
        startedAt: RUN_BUDGET_TEST_NOW,
        endedAt: null,
        expiresAt: null,
        lastEventAt: null,
        metadataJson: "{}",
        reconciliationNeeded: false,
      } satisfies RunState
      const delta = {
        amount: 5_000,
        billingPeriodId: "bp_1",
        bucketKey: "run_atomic_capture:ce_1:stmt_1:period_1",
        currency: "USD",
        entitlementId: "ce_1",
        featureId: null,
        featurePlanVersionItemId: "item_1",
        featureSlug: "tokens",
        periodEndAt: RUN_BUDGET_TEST_NOW + 60_000,
        periodStartAt: RUN_BUDGET_TEST_NOW - 60_000,
        quantity: 5,
        statementKey: "stmt_1",
      } satisfies RunSpendBucketDelta
      await store.createRun(run)
      await store.commitSpendAndIdempotency({
        run,
        updatedRun: { ...run, consumedAmount: 5_000, lastEventAt: RUN_BUDGET_TEST_NOW },
        idempotencyKey: "idem_atomic_capture",
        decision: {
          allowed: true,
          state: "processed",
          budget: {
            runId: run.runId,
            status: "running",
            budgetAmount: 10_000,
            consumedAmount: 5_000,
            remainingAmount: 5_000,
          },
          meterFacts: [],
        },
        pricedAmount: 5_000,
        bucketDeltas: [delta],
        createdAt: RUN_BUDGET_TEST_NOW,
      })
      await store.upsertCaptureIntent({
        intentKey: "intent_atomic_capture",
        runId: run.runId,
        bucketKey: delta.bucketKey,
        amount: 5_000,
        status: "pending",
        attemptCount: 0,
        lastError: null,
        createdAt: RUN_BUDGET_TEST_NOW,
        updatedAt: RUN_BUDGET_TEST_NOW,
      })

      state.storage.sql.exec(`
        CREATE TRIGGER fail_run_capture_success
        BEFORE UPDATE OF flushed_amount ON run_state
        BEGIN
          SELECT RAISE(ABORT, 'fail after bucket write');
        END
      `)
      const commit = {
        intentKey: "intent_atomic_capture",
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
})
