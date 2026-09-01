import type { CustomerEntitlementExtended } from "@unprice/db/validators"
import { type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { LEDGER_SCALE, formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"
import { z } from "zod"
import { type EntitlementService, resolveEntitlementLimit } from "../../entitlements"
import type { EntitlementWindowClient, EntitlementWindowState } from "../../ingestion"
import { toIngestionEntitlement } from "../../ingestion"

const currentEntitlementBaseShape = {
  id: z.string(),
  featureSlug: z.string(),
  featureTitle: z.string(),
  featureType: z.enum(["flat", "tier", "package", "usage"]),
  unitOfMeasure: z.string(),
  grantCount: z.number().int().nonnegative(),
}

const availableCurrentEntitlementSchema = z.object({
  ...currentEntitlementBaseShape,
  status: z.literal("available"),
  allowed: z.boolean(),
  limit: z.number().nullable(),
  usage: z.number().optional(),
  usagePercent: z.number().nullable().optional(),
  quotaWindow: z
    .object({
      periodKey: z.string(),
      startAt: z.number(),
      endAt: z.number().nullable(),
    })
    .nullable()
    .optional(),
  spending: z
    .object({
      currency: z.string().length(3),
      displayAmount: z.string(),
      ledgerAmount: z.number().int(),
      scale: z.literal(LEDGER_SCALE),
    })
    .optional(),
})

const unavailableCurrentEntitlementSchema = z.object({
  ...currentEntitlementBaseShape,
  status: z.literal("unavailable"),
})

export const customerCurrentEntitlementSchema = z.discriminatedUnion("status", [
  availableCurrentEntitlementSchema,
  unavailableCurrentEntitlementSchema,
])

export const getCustomerCurrentEntitlementsInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string(),
})

export const getCustomerCurrentEntitlementsOutputSchema = z.object({
  customerId: z.string(),
  generatedAt: z.number().int(),
  entitlements: customerCurrentEntitlementSchema.array(),
})

export type GetCustomerCurrentEntitlementsInput = z.infer<
  typeof getCustomerCurrentEntitlementsInputSchema
>
export type GetCustomerCurrentEntitlementsOutput = z.infer<
  typeof getCustomerCurrentEntitlementsOutputSchema
>

export type GetCustomerCurrentEntitlementsDeps = {
  entitlements: Pick<EntitlementService, "getCustomerEntitlementsForCustomer">
  entitlementWindowClient: EntitlementWindowClient
  logger: Pick<Logger, "error">
  now?: () => number
}

export async function getCustomerCurrentEntitlements(
  deps: GetCustomerCurrentEntitlementsDeps,
  rawInput: GetCustomerCurrentEntitlementsInput
): Promise<Result<GetCustomerCurrentEntitlementsOutput, FetchError>> {
  const input = getCustomerCurrentEntitlementsInputSchema.parse(rawInput)
  const generatedAt = deps.now?.() ?? Date.now()
  const entitlementsResult = await deps.entitlements.getCustomerEntitlementsForCustomer({
    customerId: input.customerId,
    projectId: input.projectId,
    now: generatedAt,
  })

  if (entitlementsResult.err) {
    return entitlementsResult
  }

  const rows = await Promise.all(
    entitlementsResult.val.map((entitlement) =>
      resolveCurrentEntitlement({
        deps,
        entitlement,
        generatedAt,
        input,
      })
    )
  )

  return Ok(
    getCustomerCurrentEntitlementsOutputSchema.parse({
      customerId: input.customerId,
      generatedAt,
      entitlements: rows,
    })
  )
}

async function resolveCurrentEntitlement(params: {
  deps: GetCustomerCurrentEntitlementsDeps
  entitlement: CustomerEntitlementExtended
  generatedAt: number
  input: GetCustomerCurrentEntitlementsInput
}): Promise<z.infer<typeof customerCurrentEntitlementSchema>> {
  const { deps, entitlement, generatedAt, input } = params
  const base = {
    id: entitlement.id,
    featureSlug: entitlement.featurePlanVersion.feature.slug,
    featureTitle: entitlement.featurePlanVersion.feature.title,
    featureType: entitlement.featurePlanVersion.featureType,
    unitOfMeasure: entitlement.featurePlanVersion.unitOfMeasure,
    grantCount: entitlement.grants?.length ?? 0,
  }
  const isMetered = entitlement.featurePlanVersion.featureType === "usage"

  if (!isMetered) {
    return {
      ...base,
      status: "available",
      allowed: true,
      limit: resolveEntitlementLimit({
        configuredLimit: entitlement.featurePlanVersion.limit ?? null,
        featureType: entitlement.featurePlanVersion.featureType,
        grants: entitlement.grants ?? [],
      }),
    }
  }

  const ingestionEntitlement = toIngestionEntitlement(entitlement)
  if (!ingestionEntitlement.meterConfig) {
    return { ...base, status: "unavailable" }
  }

  let state: EntitlementWindowState

  try {
    state = await deps.entitlementWindowClient
      .getEntitlementWindowStub({
        customerEntitlementId: entitlement.id,
        customerId: input.customerId,
        projectId: input.projectId,
      })
      .getEnforcementState({
        entitlement: {
          ...ingestionEntitlement,
          meterConfig: ingestionEntitlement.meterConfig,
        },
        grants: ingestionEntitlement.grants,
        now: generatedAt,
      })
  } catch (error) {
    deps.logger.error(error instanceof Error ? error : new Error(String(error)), {
      context: "current entitlement durable object read failed",
      customer_id: input.customerId,
      project_id: input.projectId,
      customer_entitlement_id: entitlement.id,
      feature_slug: base.featureSlug,
    })

    return { ...base, status: "unavailable" }
  }

  return toAvailableMeteredEntitlement(base, state)
}

function toAvailableMeteredEntitlement(
  base: Omit<z.infer<typeof unavailableCurrentEntitlementSchema>, "status">,
  state: EntitlementWindowState
): z.infer<typeof availableCurrentEntitlementSchema> {
  const usagePercent =
    state.limit !== null && state.limit > 0
      ? Math.min(100, (state.usage / state.limit) * 100)
      : null
  const amount = toDecimal(fromLedgerMinor(state.spending.ledgerAmount, state.spending.currency))

  return {
    ...base,
    status: "available",
    allowed: !state.isLimitReached,
    limit: state.limit,
    usage: state.usage,
    usagePercent,
    quotaWindow: state.quotaWindow,
    spending: {
      currency: state.spending.currency,
      displayAmount: formatMoney(amount, state.spending.currency),
      ledgerAmount: state.spending.ledgerAmount,
      scale: state.spending.scale,
    },
  }
}
