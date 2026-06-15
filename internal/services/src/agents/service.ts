import { type Database, and, desc, eq, isNull } from "@unprice/db"
import { agentRuns, agents } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { Agent, AgentRun, CreateAgentInput } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"

export class AgentService {
  constructor(private readonly deps: { db: Database; logger: Logger }) {}

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const id = newId("agent")
    const [agent] = await this.deps.db
      .insert(agents)
      .values({
        id,
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        metadata: input.metadata,
      })
      .returning()

    if (!agent) {
      throw new Error("Failed to create agent")
    }

    return agent as Agent
  }

  async listAgents(input: { projectId: string }): Promise<Agent[]> {
    return this.deps.db.query.agents.findMany({
      where: and(eq(agents.projectId, input.projectId), isNull(agents.deletedAt)),
      orderBy: [desc(agents.createdAt)],
    }) as Promise<Agent[]>
  }

  async getActiveAgent(input: { agentId: string; projectId: string }): Promise<Agent | null> {
    return (
      ((await this.deps.db.query.agents.findFirst({
        where: and(
          eq(agents.id, input.agentId),
          eq(agents.projectId, input.projectId),
          isNull(agents.deletedAt)
        ),
      })) as Agent | undefined) ?? null
    )
  }

  async getRunForAgent(input: {
    agentId: string
    customerId: string
    projectId: string
    runId: string
  }): Promise<AgentRun | null> {
    return (
      ((await this.deps.db.query.agentRuns.findFirst({
        where: and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.agentId, input.agentId),
          eq(agentRuns.customerId, input.customerId),
          eq(agentRuns.projectId, input.projectId)
        ),
      })) as AgentRun | undefined) ?? null
    )
  }
}
