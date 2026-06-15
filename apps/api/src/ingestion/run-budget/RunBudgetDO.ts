import { DurableObject } from "cloudflare:workers"
import type {
  ApplyRunSyncEventInput,
  EndRunInput,
  GetRunStatusInput,
  RunBudgetDecision,
  RunBudgetSummary,
  StartRunInput,
} from "./contracts"

/**
 * Placeholder stub — full behavior is implemented in Task 6.
 * This file exists so `env.ts` can reference the type for the binding.
 */
export class RunBudgetDO extends DurableObject {
  async startRun(_input: StartRunInput): Promise<RunBudgetSummary> {
    throw new Error("RunBudgetDO.startRun not implemented")
  }

  async applySyncEvent(_input: ApplyRunSyncEventInput): Promise<RunBudgetDecision> {
    throw new Error("RunBudgetDO.applySyncEvent not implemented")
  }

  async endRun(_input: EndRunInput): Promise<RunBudgetSummary> {
    throw new Error("RunBudgetDO.endRun not implemented")
  }

  async getRunStatus(_input: GetRunStatusInput): Promise<RunBudgetSummary> {
    throw new Error("RunBudgetDO.getRunStatus not implemented")
  }
}
