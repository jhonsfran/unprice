import { type Interval, analyticsIntervalSchema } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { paymentProviderSchema } from "@unprice/db/validators"
import { BaseError, Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import type { UnPriceCustomerError } from "../../customers/errors"
import type { DomainErrorKind } from "../../domain-error-kind"
import type { UnPriceWalletError } from "../../wallet/errors"
import {
  emptyUsageDashboardOutput,
  getUsageDashboard,
  getUsageDashboardOutputSchema,
} from "../analytics/get-usage-dashboard"
import type { GetUsageDashboardAnalytics } from "../analytics/get-usage-dashboard"
import {
  type GetCustomerCurrentAccessAnalytics,
  getCustomerCurrentAccess,
  getCustomerCurrentAccessOutputSchema,
} from "../customer/get-current-access"
import { getCustomerWallet, getCustomerWalletOutputSchema } from "../wallet/get-customer-wallet"
import { resolveWorkspaceBillingContext } from "./billing-context"

// Mirrors billing-context's WorkspaceBillingContextWorkspace: unPriceCustomerId
// is nullable so a workspace without a billing customer resolves to the graceful
// customer_id_missing branch instead of throwing on parse.
const workspaceBillingContextSchema = z.object({
  id: z.string(),
  slug: z.string(),
  unPriceCustomerId: z.string().nullable(),
})

export const getWorkspaceBillingOverviewInputSchema = z.object({
  workspace: workspaceBillingContextSchema,
  range: analyticsIntervalSchema,
})

export const getWorkspaceBillingOverviewOutputSchema = z.object({
  customerId: z.string(),
  billingProjectId: z.string(),
  paymentProvider: paymentProviderSchema.nullable(),
  access: getCustomerCurrentAccessOutputSchema,
  customer: getCustomerWalletOutputSchema.shape.customer,
  wallet: getCustomerWalletOutputSchema.shape.wallet,
  usage: getUsageDashboardOutputSchema,
})

const getWorkspaceBillingOverviewErrorCodeSchema = z.enum([
  "WORKSPACE_BILLING_CUSTOMER_ID_MISSING",
  "WORKSPACE_BILLING_CUSTOMER_NOT_FOUND",
  "WORKSPACE_BILLING_CURRENCY_NOT_FOUND",
  "WORKSPACE_BILLING_ACCESS_NOT_FOUND",
  "WORKSPACE_BILLING_WALLET_NOT_FOUND",
])

type GetWorkspaceBillingOverviewErrorCode = z.infer<
  typeof getWorkspaceBillingOverviewErrorCodeSchema
>

const getWorkspaceBillingOverviewErrorKinds: Record<
  GetWorkspaceBillingOverviewErrorCode,
  DomainErrorKind
> = {
  WORKSPACE_BILLING_CUSTOMER_ID_MISSING: "bad_request",
  WORKSPACE_BILLING_CUSTOMER_NOT_FOUND: "not_found",
  WORKSPACE_BILLING_CURRENCY_NOT_FOUND: "precondition",
  WORKSPACE_BILLING_ACCESS_NOT_FOUND: "not_found",
  WORKSPACE_BILLING_WALLET_NOT_FOUND: "not_found",
}

export type GetWorkspaceBillingOverviewInput = z.infer<
  typeof getWorkspaceBillingOverviewInputSchema
>
export type GetWorkspaceBillingOverviewOutput = z.infer<
  typeof getWorkspaceBillingOverviewOutputSchema
>

export class GetWorkspaceBillingOverviewError extends BaseError<{
  billingProjectId?: string
  customerId?: string
  workspaceId?: string
}> {
  public readonly code: GetWorkspaceBillingOverviewErrorCode
  public readonly kind: DomainErrorKind
  public readonly retry = false
  public override readonly name = "GetWorkspaceBillingOverviewError"

  constructor(opts: {
    code: GetWorkspaceBillingOverviewErrorCode
    message: string
    context?: {
      billingProjectId?: string
      customerId?: string
      workspaceId?: string
    }
  }) {
    super({
      message: opts.message,
      context: opts.context ?? {},
    })
    this.code = opts.code
    this.kind = getWorkspaceBillingOverviewErrorKinds[opts.code]
  }
}

export type GetWorkspaceBillingOverviewDeps = {
  services: Pick<ServiceContext, "customers" | "wallet">
  db: Database
  analytics: GetCustomerCurrentAccessAnalytics & GetUsageDashboardAnalytics
  logger: Logger
  now?: () => number
}

type GetWorkspaceBillingOverviewFailure =
  | GetWorkspaceBillingOverviewError
  | FetchError
  | UnPriceCustomerError
  | UnPriceWalletError

/**
 * Read model for the workspace billing settings page. Owns the customer/currency
 * resolution (shared with the other workspace-billing reads via
 * resolveWorkspaceBillingContext), the access/wallet/usage fan-out, and the
 * soft-fail policy for usage: a usage-dashboard failure degrades to an empty
 * dashboard with the error surfaced in-band rather than failing the whole page.
 */
export async function getWorkspaceBillingOverview(
  deps: GetWorkspaceBillingOverviewDeps,
  rawInput: GetWorkspaceBillingOverviewInput
): Promise<Result<GetWorkspaceBillingOverviewOutput, GetWorkspaceBillingOverviewFailure>> {
  const input = getWorkspaceBillingOverviewInputSchema.parse(rawInput)
  const range: Interval = input.range

  deps.logger.set({
    business: {
      operation: "workspace.get_billing_overview",
      workspace_id: input.workspace.id,
      unprice_customer_id: input.workspace.unPriceCustomerId ?? undefined,
    },
  })

  const contextResult = await resolveWorkspaceBillingContext(deps, input.workspace)

  if (contextResult.err) {
    return Err(contextResult.err)
  }

  if (!contextResult.val.ok) {
    switch (contextResult.val.reason) {
      case "customer_id_missing":
        return Err(
          new GetWorkspaceBillingOverviewError({
            code: "WORKSPACE_BILLING_CUSTOMER_ID_MISSING",
            message: "Workspace billing customer not found",
            context: {
              workspaceId: input.workspace.id,
            },
          })
        )
      case "customer_not_found":
        return Err(
          new GetWorkspaceBillingOverviewError({
            code: "WORKSPACE_BILLING_CUSTOMER_NOT_FOUND",
            message: "Workspace billing customer not found",
            context: {
              workspaceId: input.workspace.id,
              customerId: input.workspace.unPriceCustomerId ?? undefined,
            },
          })
        )
      case "currency_not_found":
        return Err(
          new GetWorkspaceBillingOverviewError({
            code: "WORKSPACE_BILLING_CURRENCY_NOT_FOUND",
            message: "Workspace billing currency not found",
            context: {
              workspaceId: input.workspace.id,
              customerId: input.workspace.unPriceCustomerId ?? undefined,
            },
          })
        )
    }
  }

  const { customerId, billingProjectId } = contextResult.val.context

  const [accessResult, walletResult, usageResult] = await Promise.all([
    getCustomerCurrentAccess(
      {
        db: deps.db,
        analytics: deps.analytics,
        logger: deps.logger,
        now: deps.now,
      },
      {
        projectId: billingProjectId,
        customerId,
      }
    ),
    getCustomerWallet(
      {
        services: {
          customers: deps.services.customers,
          wallet: deps.services.wallet,
        },
        logger: deps.logger,
      },
      {
        projectId: billingProjectId,
        customerId,
      }
    ),
    getUsageDashboard(
      {
        analytics: deps.analytics,
        db: deps.db,
        now: deps.now,
      },
      {
        projectId: billingProjectId,
        customerId,
        range,
      }
    ),
  ])

  if (accessResult.err) {
    return Err(accessResult.err)
  }

  if (!accessResult.val) {
    return Err(
      new GetWorkspaceBillingOverviewError({
        code: "WORKSPACE_BILLING_ACCESS_NOT_FOUND",
        message: "Workspace billing access not found",
        context: {
          workspaceId: input.workspace.id,
          customerId,
          billingProjectId,
        },
      })
    )
  }

  if (walletResult.err) {
    return Err(walletResult.err)
  }

  if (!walletResult.val) {
    return Err(
      new GetWorkspaceBillingOverviewError({
        code: "WORKSPACE_BILLING_WALLET_NOT_FOUND",
        message: "Workspace billing wallet not found",
        context: {
          workspaceId: input.workspace.id,
          customerId,
          billingProjectId,
        },
      })
    )
  }

  if (usageResult.err) {
    deps.logger.error(usageResult.err, {
      context: "workspace billing usage dashboard failed",
      project_id: billingProjectId,
      customer_id: customerId,
      range,
    })
  }

  return Ok(
    getWorkspaceBillingOverviewOutputSchema.parse({
      customerId,
      billingProjectId,
      paymentProvider: accessResult.val.activePlan?.activePhase?.paymentProvider ?? null,
      access: accessResult.val,
      customer: walletResult.val.customer,
      wallet: walletResult.val.wallet,
      usage:
        usageResult.val ??
        emptyUsageDashboardOutput(
          range,
          usageResult.err instanceof Error ? usageResult.err.message : "Failed to fetch usage"
        ),
    })
  )
}
