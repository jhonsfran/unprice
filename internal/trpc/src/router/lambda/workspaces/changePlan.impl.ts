import { TRPCError } from "@trpc/server"
import type { WorkspaceRole } from "@unprice/db/validators"
import {
  WorkspaceChangePlanError,
  type WorkspaceChangePlanInput,
  changeWorkspacePlan,
} from "@unprice/services/use-cases"
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
    throw changePlanErrorToTrpcError(result.err)
  }

  return result.val
}

function isSchemaLikeError(error: unknown): error is Error {
  return error instanceof Error && error.name === "SchemaError"
}

function isFetchLikeError(error: unknown): error is Error {
  return error instanceof Error && error.name === "FetchError"
}

function isCustomerLikeError(error: unknown): error is Error & { code?: unknown } {
  return error instanceof Error && error.name === "UnPriceCustomerError"
}

function isSubscriptionLikeError(error: unknown): error is Error {
  return error instanceof Error && error.name === "UnPriceSubscriptionError"
}

function isBillingLikeError(error: unknown): error is Error {
  return error instanceof Error && error.name === "UnPriceBillingError"
}

export function changePlanErrorToTrpcError(error: unknown): TRPCError {
  if (error instanceof WorkspaceChangePlanError) {
    switch (error.code) {
      case "WORKSPACE_BILLING_CUSTOMER_ID_MISSING":
      case "WORKSPACE_TARGET_PLAN_VERSION_NOT_FOUND":
        return new TRPCError({ code: "BAD_REQUEST", message: error.message })
      case "WORKSPACE_BILLING_CUSTOMER_NOT_FOUND":
      case "WORKSPACE_BILLING_CURRENCY_NOT_FOUND":
      case "WORKSPACE_BILLING_ACCESS_NOT_FOUND":
      case "WORKSPACE_TARGET_PLAN_VERSION_WRONG_PROJECT":
      case "WORKSPACE_TARGET_PLAN_VERSION_SAME_AS_CURRENT":
      case "WORKSPACE_TARGET_PLAN_VERSION_INACTIVE":
      case "WORKSPACE_TARGET_PLAN_VERSION_UNPUBLISHED":
      case "WORKSPACE_TARGET_PLAN_VERSION_ARCHIVED":
      case "WORKSPACE_TARGET_PLAN_VERSION_WRONG_CURRENCY":
      case "WORKSPACE_TARGET_PLAN_PROVIDER_UNAVAILABLE":
        return new TRPCError({ code: "PRECONDITION_FAILED", message: error.message })
    }
  }

  if (isSchemaLikeError(error)) {
    return new TRPCError({ code: "BAD_REQUEST", message: error.message })
  }

  if (
    isFetchLikeError(error) ||
    isCustomerLikeError(error) ||
    isSubscriptionLikeError(error) ||
    isBillingLikeError(error)
  ) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: error.message })
  }

  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: error instanceof Error ? error.message : "Failed to change workspace plan",
  })
}
