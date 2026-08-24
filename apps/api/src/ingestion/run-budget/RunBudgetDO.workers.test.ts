import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RunBudgetDO } from "./RunBudgetDO"
import type {
  ApplyRunSyncEventInput,
  EndRunInput,
  GetRunStatusInput,
  StartRunInput,
} from "./contracts"
import * as schema from "./db/schema"
import type { RunBudgetWalletOps } from "./ports"
import { RunBudgetProcessor } from "./processor"
import { RunBudgetRpcShell } from "./rpc-shell"
import { RunBudgetStore } from "./run-budget-store"
import { RUN_BUDGET_TEST_NOW, createRunBudgetMeterFact } from "./testing/harness"
import {
  type RunBudgetProcessorContractTarget,
  createRunBudgetApplyInput,
  createRunBudgetStartInput,
  describeRunBudgetProcessorContract,
} from "./testing/processor-contract"

afterEach(async () => {
  await reset()
})

describeRunBudgetProcessorContract(
  "RunBudgetProcessor (Durable Object SQLite contract)",
  async () => {
    const name = `test:run-budget-contract:${crypto.randomUUID()}`
    const clockOrigin = Date.now() + 7 * 24 * 60 * 60 * 1000
    const translateContractTime = (timestamp: number) =>
      clockOrigin + (timestamp - RUN_BUDGET_TEST_NOW)
    const stats = {
      pricingCalls: 0,
      captureCalls: 0,
      captureFailing: false,
      now: clockOrigin,
      schedulerFailures: 0,
    }
    const createTarget = (): RunBudgetProcessorContractTarget => {
      const stub = env.runbudget.getByName(name)
      const invoke = async <T>(fn: (processor: RunBudgetProcessor) => Promise<T>): Promise<T> =>
        runInDurableObject(stub, async (instance: RunBudgetDO, state) => {
          await instance
            .getRunStatus({
              runId: "__contract_bootstrap__",
              customerId: "cus_1",
              projectId: "proj_1",
            })
            .catch(() => undefined)

          const wallet = {
            createReservation: vi.fn(
              async (_input: Parameters<RunBudgetWalletOps["createReservation"]>[0]) => ({
                val: { reservationId: "res_workers_123", allocationAmount: 100_000 },
              })
            ),
            captureReservationUsage: vi.fn(
              async (_input: Parameters<RunBudgetWalletOps["captureReservationUsage"]>[0]) => {
                stats.captureCalls++
                if (stats.captureFailing) throw new Error("wallet unavailable")
                return { val: { capturedAmount: 0 } }
              }
            ),
            releaseReservation: vi.fn(
              async (_input: Parameters<RunBudgetWalletOps["releaseReservation"]>[0]) => ({
                val: {
                  releasedAmount: 0,
                  restoredGrantedAmount: 0,
                  refundedPurchasedAmount: 0,
                },
              })
            ),
          } satisfies RunBudgetWalletOps
          const processor = new RunBudgetProcessor({
            clock: { now: () => stats.now },
            logger: { error: () => undefined },
            pricing: {
              apply: async (input) => {
                stats.pricingCalls++
                const fact = createRunBudgetMeterFact()
                return fact.amount > input.wallet.remainingAmount
                  ? {
                      allowed: false,
                      deniedReason: "RUN_BUDGET_EXCEEDED",
                      message: "Run budget exceeded",
                      meterFacts: [],
                    }
                  : { allowed: true, meterFacts: [fact] }
              },
            },
            scheduler: {
              getAlarm: () => state.storage.getAlarm(),
              setAlarm: (at) => {
                if (stats.schedulerFailures > 0) {
                  stats.schedulerFailures--
                  throw new Error("scheduler unavailable")
                }
                return state.storage.setAlarm(at)
              },
            },
            store: new RunBudgetStore(drizzle(state.storage, { schema, logger: false })),
            wallet: { create: async () => wallet },
          })
          return fn(processor)
        })

      return {
        startRun: (input: StartRunInput) =>
          invoke((processor) =>
            processor.startRun({
              ...input,
              now: translateContractTime(input.now),
              expiresAt:
                input.expiresAt == null ? input.expiresAt : translateContractTime(input.expiresAt),
            })
          ),
        applySyncEvent: (input: ApplyRunSyncEventInput) =>
          invoke((processor) =>
            processor.applySyncEvent({ ...input, now: translateContractTime(input.now) })
          ),
        endRun: (input: EndRunInput) =>
          invoke((processor) =>
            processor.endRun({ ...input, endedAt: translateContractTime(input.endedAt) })
          ),
        getRunStatus: (input: GetRunStatusInput) =>
          invoke((processor) => processor.getRunStatus(input)),
        flushCaptures: () => invoke((processor) => processor.flushCaptures()),
        alarm: () => invoke((processor) => processor.alarm()),
        advanceClock: (milliseconds) => {
          stats.now += milliseconds
        },
        setCaptureFailure: (failing) => {
          stats.captureFailing = failing
        },
        failNextSchedulerCall: () => {
          stats.schedulerFailures++
        },
        alarmAt: () =>
          runInDurableObject(stub, async (_instance: RunBudgetDO, state) =>
            state.storage.getAlarm()
          ),
        captureCallCount: () => stats.captureCalls,
        captureAttemptCount: () =>
          runInDurableObject(stub, async (_instance: RunBudgetDO, state) => {
            const store = new RunBudgetStore(drizzle(state.storage, { schema, logger: false }))
            const intents = [
              ...(await store.listRetryableCaptureIntents()),
              ...(await store.findAbandonedCaptureIntents("run_1")),
            ]
            return intents[0]?.attemptCount ?? 0
          }),
        clockNow: () => stats.now,
        pricingCallCount: () => stats.pricingCalls,
      }
    }

    return {
      target: createTarget(),
      revive: async () => {
        await evictDurableObject(env.runbudget.getByName(name))
        return createTarget()
      },
    }
  }
)

describe("RunBudgetProcessor (Durable Object shared run concurrency)", () => {
  it("does not overspend a shared run when concurrent consumes arrive", async () => {
    const stub = env.runbudget.getByName(`test:run-budget-shared:${crypto.randomUUID()}`)
    const wallet = {
      createReservation: vi.fn(
        async (_input: Parameters<RunBudgetWalletOps["createReservation"]>[0]) => ({
          val: { reservationId: "res_workers_shared_123", allocationAmount: 5 },
        })
      ),
      captureReservationUsage: vi.fn(
        async (_input: Parameters<RunBudgetWalletOps["captureReservationUsage"]>[0]) => ({
          val: { capturedAmount: 0 },
        })
      ),
      releaseReservation: vi.fn(
        async (_input: Parameters<RunBudgetWalletOps["releaseReservation"]>[0]) => ({
          val: {
            releasedAmount: 0,
            restoredGrantedAmount: 0,
            refundedPurchasedAmount: 0,
          },
        })
      ),
    } satisfies RunBudgetWalletOps
    let alarmAt: number | null = null
    let rpc: RunBudgetRpcShell | undefined

    const invoke = async <T>(fn: (activeRpc: RunBudgetRpcShell) => Promise<T>): Promise<T> =>
      runInDurableObject(stub, async (instance: RunBudgetDO, state) => {
        await instance
          .getRunStatus({ runId: "__shared_bootstrap__", customerId: "cus_1", projectId: "proj_1" })
          .catch(() => undefined)

        rpc ??= new RunBudgetRpcShell(
          new RunBudgetProcessor({
            clock: { now: () => RUN_BUDGET_TEST_NOW },
            logger: { error: () => undefined },
            pricing: {
              apply: async (input) => {
                const fact = createRunBudgetMeterFact({ amount: 1 })
                return fact.amount > input.wallet.remainingAmount
                  ? {
                      allowed: false,
                      deniedReason: "RUN_BUDGET_EXCEEDED",
                      message: "Run budget exceeded",
                      meterFacts: [],
                    }
                  : { allowed: true, meterFacts: [fact] }
              },
            },
            scheduler: {
              getAlarm: async () => alarmAt,
              setAlarm: async (at) => {
                alarmAt = at
              },
            },
            store: new RunBudgetStore(drizzle(state.storage, { schema, logger: false })),
            wallet: { create: async () => wallet },
          }),
          (mutation) => state.blockConcurrencyWhile(mutation)
        )

        return fn(rpc)
      })

    await invoke((activeRpc) => activeRpc.startRun(createRunBudgetStartInput({ budgetAmount: 5 })))
    const inputs = Array.from({ length: 10 }, (_, index) =>
      createRunBudgetApplyInput({
        idempotencyKey: `idem_consume_shared_${index}`,
        event: {
          ...createRunBudgetApplyInput().event,
          id: `evt_shared_${index}`,
        },
      })
    )
    const decisions = await Promise.all(
      inputs.map((input) => invoke((activeRpc) => activeRpc.applySyncEvent(input)))
    )
    const accepted = inputs
      .map((input, index) => ({ input, decision: decisions[index] }))
      .filter(({ decision }) => decision.allowed)
    const rejected = decisions.filter((decision) => !decision.allowed)

    expect(accepted).toHaveLength(5)
    expect(rejected).toHaveLength(5)
    expect(rejected.every((decision) => decision.rejectionReason === "RUN_BUDGET_EXCEEDED")).toBe(
      true
    )
    expect(decisions.every((decision) => decision.budget.remainingAmount >= 0)).toBe(true)
    expect(
      accepted.reduce(
        (amount, { decision }) =>
          amount + decision.meterFacts.reduce((sum, meterFact) => sum + meterFact.amount, 0),
        0
      )
    ).toBeLessThanOrEqual(5)
    expect(
      Math.max(...decisions.map((decision) => decision.budget.consumedAmount))
    ).toBeLessThanOrEqual(5)

    await expect(
      invoke((activeRpc) =>
        activeRpc.getRunStatus({
          runId: "run_1",
          customerId: "cus_1",
          projectId: "proj_1",
        })
      )
    ).resolves.toMatchObject({ consumedAmount: 5, remainingAmount: 0 })

    const acceptedPair = accepted[0]
    if (!acceptedPair) throw new Error("Expected at least one accepted consume decision")
    await expect(
      invoke((activeRpc) => activeRpc.applySyncEvent(acceptedPair.input))
    ).resolves.toEqual(acceptedPair.decision)
    await expect(
      invoke((activeRpc) =>
        activeRpc.getRunStatus({
          runId: "run_1",
          customerId: "cus_1",
          projectId: "proj_1",
        })
      )
    ).resolves.toMatchObject({ consumedAmount: 5, remainingAmount: 0 })
  })
})
