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
import { RUN_BUDGET_TEST_NOW, createRunBudgetMeterFact } from "./testing/harness"
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
    const stats = { pricingCalls: 0 }
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
            createReservation: vi.fn(async () => ({
              err: null,
              val: { reservationId: "res_workers_123", allocationAmount: 100_000 },
            })),
            captureReservationUsage: vi.fn(async () => ({
              err: null,
              val: { capturedAmount: 0 },
            })),
            releaseReservation: vi.fn(async () => ({
              err: null,
              val: { releasedAmount: 0 },
            })),
          } as unknown as RunBudgetWalletOps
          const processor = new RunBudgetProcessor({
            clock: { now: () => RUN_BUDGET_TEST_NOW },
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
              setAlarm: (at) => state.storage.setAlarm(at),
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
