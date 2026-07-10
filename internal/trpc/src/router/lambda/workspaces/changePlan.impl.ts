import type { WorkspaceRole } from "@unprice/db/validators"
import { type WorkspaceChangePlanInput, changeWorkspacePlan } from "@unprice/services/use-cases"
import { domainErrorToTrpcError } from "#domain-error"
import type { Context } from "#trpc"

export type ChangePlanMutationCtx = Pick<Context, "analytics" | "db" | "logger" | "services"> & {
  verifyRole: (roles: WorkspaceRole[]) => void
  workspace: {
    id: string
    slug: string
    unPriceCustomerId: string | null
  }
}

export async function changePlanMutation(opts: {
  input: WorkspaceChangePlanInput
  ctx: ChangePlanMutationCtx
}) {
  opts.ctx.verifyRole(["OWNER", "ADMIN"])

  const result = await changeWorkspacePlan(
    {
      services: {
        billing: opts.ctx.services.billing,
        customers: opts.ctx.services.customers,
        plans: opts.ctx.services.plans,
        subscriptions: opts.ctx.services.subscriptions,
      },
      db: opts.ctx.db,
      analytics: opts.ctx.analytics,
      logger: opts.ctx.logger,
    },
    {
      ...opts.input,
      workspace: opts.ctx.workspace,
    }
  )

  if (result.err) {
    throw domainErrorToTrpcError(result.err, "Failed to change workspace plan")
  }

  return result.val
}
