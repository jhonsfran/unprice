import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { afterEach, vi } from "vitest"
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
import { RunBudgetStore } from "./run-budget-store"
import { createRunBudgetMeterFact } from "./testing/harness"
import {
  type RunBudgetProcessorContractTarget,
  describeRunBudgetProcessorContract,
} from "./testing/processor-contract"

afterEach(async () => {
  await reset()
})

describeRunBudgetProcessorContract(
  "RunBudgetProcessor (Durable Object SQLite contract)",
  async () => {
    const name = `test:run-budget-contract:${crypto.randomUUID()}`
    const stats = {
      pricingCalls: 0,
      captureCalls: 0,
      captureFailing: false,
      now: Date.now(),
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
        startRun: (input: StartRunInput) => invoke((processor) => processor.startRun(input)),
        applySyncEvent: (input: ApplyRunSyncEventInput) =>
          invoke((processor) => processor.applySyncEvent(input)),
        endRun: (input: EndRunInput) => invoke((processor) => processor.endRun(input)),
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
