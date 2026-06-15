import type {
  ApplyAgentRunSyncEventInput,
  EndAgentRunInput,
  StartAgentRunInput,
} from "@unprice/db/validators"
import type {
  AgentRunBudgetSummary,
  AgentRunSyncDecision,
  RunBudgetClient,
} from "@unprice/services/use-cases"
import type { Env } from "~/env"

export class CloudflareRunBudgetClient implements RunBudgetClient {
  constructor(private readonly env: Pick<Env, "runbudget">) {}

  async startRun(input: StartAgentRunInput): Promise<AgentRunBudgetSummary> {
    return this.stub(input).startRun({
      ...input,
      runId: input.agentId,
      now: Date.now(),
      budgetAmount: input.budgetAmount,
      expiresAt: input.expiresAt ? input.expiresAt.getTime() : undefined,
    })
  }

  async applySyncEvent(input: ApplyAgentRunSyncEventInput): Promise<AgentRunSyncDecision> {
    return this.stub(input).applySyncEvent(input)
  }

  async endRun(input: EndAgentRunInput): Promise<AgentRunBudgetSummary> {
    return this.stub(input).endRun({
      ...input,
      endedAt: input.endedAt.getTime(),
    })
  }

  async getRunStatus(input: {
    agentId: string
    customerId: string
    projectId: string
    runId: string
  }): Promise<AgentRunBudgetSummary> {
    return this.stub(input).getRunStatus(input)
  }

  private stub(input: { projectId: string; customerId: string; runId?: string }) {
    const id = this.env.runbudget.idFromName(
      `${input.projectId}:${input.customerId}:${input.runId ?? "unknown"}`
    )
    return this.env.runbudget.get(id)
  }
}
