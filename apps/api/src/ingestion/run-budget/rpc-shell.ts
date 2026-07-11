import type {
  ApplyRunSyncEventInput,
  EndRunInput,
  FlushRunBudgetCapturesForInvoicingInput,
  FlushRunBudgetCapturesForInvoicingResult,
  GetRunStatusInput,
  RunBudgetDecision,
  RunBudgetSummary,
  StartRunInput,
} from "./contracts"
import type { RunBudgetProcessor } from "./processor"

type RunBudgetRpcTarget = Pick<
  RunBudgetProcessor,
  | "alarm"
  | "applySyncEvent"
  | "endRun"
  | "flushCaptures"
  | "flushCapturesForInvoicing"
  | "getRunStatus"
  | "startRun"
>

export type RunBudgetMutationSerializer = <T>(mutation: () => Promise<T>) => Promise<T>

/**
 * RPC composition boundary shared by Cloudflare and tests. Every state-changing
 * operation uses the same serializer; status reads stay outside the mutation queue.
 */
export class RunBudgetRpcShell {
  constructor(
    private readonly target: RunBudgetRpcTarget,
    private readonly serializeMutation: RunBudgetMutationSerializer
  ) {}

  startRun(input: StartRunInput): Promise<RunBudgetSummary> {
    return this.serializeMutation(() => this.target.startRun(input))
  }

  applySyncEvent(input: ApplyRunSyncEventInput): Promise<RunBudgetDecision> {
    return this.serializeMutation(() => this.target.applySyncEvent(input))
  }

  endRun(input: EndRunInput): Promise<RunBudgetSummary> {
    return this.serializeMutation(() => this.target.endRun(input))
  }

  getRunStatus(input: GetRunStatusInput): Promise<RunBudgetSummary> {
    return this.target.getRunStatus(input)
  }

  flushCaptures(): Promise<void> {
    return this.serializeMutation(() => this.target.flushCaptures())
  }

  flushCapturesForInvoicing(
    input: FlushRunBudgetCapturesForInvoicingInput
  ): Promise<FlushRunBudgetCapturesForInvoicingResult> {
    return this.serializeMutation(() => this.target.flushCapturesForInvoicing(input))
  }

  alarm(): Promise<void> {
    return this.serializeMutation(() => this.target.alarm())
  }
}
