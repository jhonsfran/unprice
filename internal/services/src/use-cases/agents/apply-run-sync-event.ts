import type { ApplyAgentRunSyncEventInput } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { AgentService } from "../../agents"
import type { AgentRunSyncDecision, RunBudgetClient } from "./run-budget-client"
import { AgentRunUseCaseError } from "./start-run"

export async function applyAgentRunSyncEvent(
  deps: {
    services: { agents: Pick<AgentService, "getRunForAgent"> }
    runBudget: Pick<RunBudgetClient, "applySyncEvent">
  },
  input: ApplyAgentRunSyncEventInput
): Promise<Result<AgentRunSyncDecision, AgentRunUseCaseError>> {
  const run = await deps.services.agents.getRunForAgent({
    agentId: input.agentId,
    customerId: input.customerId,
    projectId: input.projectId,
    runId: input.runId,
  })

  if (!run) {
    return Err(new AgentRunUseCaseError("RUN_NOT_FOUND"))
  }

  return Ok(await deps.runBudget.applySyncEvent(input))
}
