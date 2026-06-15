import type {
  ApplyAgentRunSyncEventInput,
  EndAgentRunInput,
  StartAgentRunInput,
} from "@unprice/db/validators"

export type AgentRunBudgetSummary = {
  runId: string
  status: "running" | "completed" | "expired" | "canceled" | "budget_exceeded" | "failed"
  budgetAmount: number
  consumedAmount: number
  remainingAmount: number
}

export type AgentRunSyncDecision = {
  allowed: boolean
  state: "processed" | "rejected"
  rejectionReason?:
    | "LIMIT_EXCEEDED"
    | "WALLET_EMPTY"
    | "LATE_EVENT_CLOSED_PERIOD"
    | "RUN_BUDGET_EXCEEDED"
  message?: string
  budget: AgentRunBudgetSummary
}

export interface RunBudgetClient {
  startRun(input: StartAgentRunInput): Promise<AgentRunBudgetSummary>
  applySyncEvent(input: ApplyAgentRunSyncEventInput): Promise<AgentRunSyncDecision>
  endRun(input: EndAgentRunInput): Promise<AgentRunBudgetSummary>
  getRunStatus(input: {
    agentId: string
    customerId: string
    projectId: string
    runId: string
  }): Promise<AgentRunBudgetSummary>
}
