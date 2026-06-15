import type { StartAgentRunInput } from "@unprice/db/validators"
import { BaseError, Err, Ok, type Result } from "@unprice/error"
import type { AgentService } from "../../agents"
import type { AgentRunBudgetSummary, RunBudgetClient } from "./run-budget-client"

export class AgentRunUseCaseError extends BaseError {
  public readonly retry = false
  public readonly name = "AgentRunUseCaseError"

  constructor(message: "AGENT_NOT_FOUND" | "RUN_NOT_FOUND") {
    super({ message })
  }
}

export async function startAgentRun(
  deps: {
    services: { agents: Pick<AgentService, "getActiveAgent"> }
    runBudget: Pick<RunBudgetClient, "startRun">
  },
  input: StartAgentRunInput
): Promise<Result<AgentRunBudgetSummary, AgentRunUseCaseError>> {
  const agent = await deps.services.agents.getActiveAgent({
    agentId: input.agentId,
    projectId: input.projectId,
  })

  if (!agent) {
    return Err(new AgentRunUseCaseError("AGENT_NOT_FOUND"))
  }

  return Ok(await deps.runBudget.startRun(input))
}
