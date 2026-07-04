import type { Unprice } from "@unprice/api"
import type { Database } from "@unprice/db"
import {
  type Currency,
  type Feature,
  type MeterConfig,
  type PlanVersionFeature,
  currencySchema,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { fromCurrencyMinor, toLedgerMinor } from "@unprice/money"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import { createSubscriptionFlow } from "../subscription/create-shared"

const usageSeedValues = [2, 3, 5]
const onboardingRunBudgetAmountMinor = 5000
const onboardingCreditLineAmountMinor = 10000

export const seedOnboardingEvidenceRequestSchema = z.object({
  planVersionId: z.string().min(1),
})

export const seedOnboardingEvidenceInputSchema = seedOnboardingEvidenceRequestSchema.extend({
  projectId: z.string().min(1),
  projectTimezone: z.string().min(1).default("UTC"),
  projectDefaultCurrency: currencySchema.optional(),
  workspaceIsMain: z.boolean().default(false),
})

export const seedOnboardingEvidenceOutputSchema = z.object({
  state: z.literal("ok"),
  apiKey: z.object({
    id: z.string(),
  }),
  customer: z.object({
    id: z.string(),
    name: z.string().nullable().optional(),
    email: z.string(),
  }),
  subscription: z.object({
    id: z.string(),
  }),
  usage: z.object({
    state: z.enum(["done", "skipped"]),
    eventsRecorded: z.number().int().min(0),
    targetCount: z.number().int().min(0),
  }),
  verification: z.object({
    state: z.enum(["done", "skipped"]),
    allowed: z.boolean().optional(),
    featureSlug: z.string().optional(),
  }),
})

export type SeedOnboardingEvidenceRequest = z.input<typeof seedOnboardingEvidenceRequestSchema>
export type SeedOnboardingEvidenceInput = z.input<typeof seedOnboardingEvidenceInputSchema>
export type SeedOnboardingEvidenceOutput = z.infer<typeof seedOnboardingEvidenceOutputSchema>

type EvidenceApiClient = {
  runs: Pick<Unprice["runs"], "start" | "consume" | "end">
  access: Pick<Unprice["access"], "check">
}

type SeedOnboardingEvidenceDeps = {
  services: Pick<ServiceContext, "plans" | "apikeys" | "customers" | "subscriptions" | "billing">
  db: Database
  logger: Logger
  createApiClient: (token: string) => EvidenceApiClient
}

type DetailedPlanFeature = PlanVersionFeature & {
  feature?: Feature | null
}

type UsageSeedTarget = {
  featureSlug: string
  eventSlug: string
  aggregationField?: string
}

function seedError(message: string, context?: Record<string, unknown>) {
  return new FetchError({
    message,
    retry: false,
    ...(context
      ? { context: { url: "onboarding://seed-evidence", method: "POST", ...context } }
      : {}),
  })
}

function apiErrorMessage(prefix: string, error: { message: string; code?: string }) {
  const code = error.code ? ` (${error.code})` : ""
  return `${prefix}${code}: ${error.message}`
}

function getUsageSeedTargets(planFeatures: DetailedPlanFeature[]): UsageSeedTarget[] {
  const targets = new Map<string, UsageSeedTarget>()

  for (const planFeature of planFeatures) {
    if (planFeature.featureType !== "usage") {
      continue
    }

    const meterConfig = planFeature.meterConfig as MeterConfig | null | undefined
    if (!meterConfig?.eventSlug) {
      continue
    }

    const featureSlug = planFeature.feature?.slug ?? meterConfig.eventSlug
    const key = `${featureSlug}:${meterConfig.aggregationField ?? "count"}`

    targets.set(key, {
      featureSlug,
      eventSlug: meterConfig.eventSlug,
      aggregationField: meterConfig.aggregationField,
    })
  }

  return Array.from(targets.values())
}

function getVerificationFeatureSlug(planFeatures: DetailedPlanFeature[]) {
  return (
    planFeatures.find((planFeature) => planFeature.feature && !planFeature.metadata?.hidden)
      ?.feature?.slug ?? planFeatures.find((planFeature) => planFeature.feature)?.feature?.slug
  )
}

function normalizeCurrency(currency?: Currency) {
  return currency === "EUR" || currency === "USD" ? currency : undefined
}

async function closeStartedRunAfterFailure({
  apiClient,
  customerId,
  logger,
  planVersionId,
  runId,
}: {
  apiClient: EvidenceApiClient
  customerId: string
  logger: Logger
  planVersionId: string
  runId: string
}) {
  try {
    const endResult = await apiClient.runs.end({
      runId,
      status: "failed",
    })

    if (endResult.error) {
      logger.warn("failed to close onboarding budgeted run after evidence error", {
        customerId,
        planVersionId,
        runId,
        error: endResult.error.message,
        code: endResult.error.code,
      })
    }
  } catch (error) {
    logger.warn("failed to close onboarding budgeted run after evidence error", {
      customerId,
      planVersionId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function seedOnboardingEvidence(
  deps: SeedOnboardingEvidenceDeps,
  rawInput: SeedOnboardingEvidenceInput
): Promise<Result<SeedOnboardingEvidenceOutput, FetchError>> {
  const input = seedOnboardingEvidenceInputSchema.parse(rawInput)

  deps.logger.set({
    business: {
      operation: "onboarding.seed-evidence",
      project_id: input.projectId,
      plan_version_id: input.planVersionId,
    },
  })

  const planVersionResult = await deps.services.plans.getPlanVersionByIdDetailed({
    projectId: input.projectId,
    planVersionId: input.planVersionId,
  })

  if (planVersionResult.err) {
    return Err(planVersionResult.err)
  }

  const planVersion = planVersionResult.val
  if (!planVersion) {
    return Err(seedError("Plan version not found. Please return to the previous step."))
  }

  const planFeatures = planVersion.planFeatures as DetailedPlanFeature[]
  if (planFeatures.length === 0) {
    return Err(seedError("Your plan needs at least one feature before we can seed evidence."))
  }

  const now = Date.now()
  const customerResult = await deps.services.customers.createCustomerRecord({
    projectId: input.projectId,
    name: "Onboarding Customer",
    email: `onboarding+${now}@example.com`,
    defaultCurrency: normalizeCurrency(input.projectDefaultCurrency),
    timezone: input.projectTimezone,
  })

  if (customerResult.err) {
    return Err(customerResult.err)
  }

  const customer = customerResult.val
  const apiKeyResult = await deps.services.apikeys.createApiKey({
    projectId: input.projectId,
    name: `onboarding-${now}`,
    isRoot: input.workspaceIsMain,
    defaultCustomerId: customer.id,
  })

  if (apiKeyResult.err) {
    return Err(apiKeyResult.err)
  }

  const apiKey = apiKeyResult.val
  const subscriptionResult = await createSubscriptionFlow(
    {
      services: deps.services,
      db: deps.db,
      logger: deps.logger,
    },
    {
      projectId: input.projectId,
      input: {
        customerId: customer.id,
        timezone: input.projectTimezone,
        phases: [
          {
            planVersionId: input.planVersionId,
            startAt: now - 5 * 60 * 1000,
            trialUnits: planVersion.trialUnits ?? 0,
            creditLinePolicy: "capped",
            creditLineAmount: toLedgerMinor(
              fromCurrencyMinor(onboardingCreditLineAmountMinor, planVersion.currency)
            ),
          },
        ],
      },
    }
  )

  if (subscriptionResult.err) {
    return Err(
      seedError(`Subscription setup failed: ${subscriptionResult.err.message}`, {
        customerId: customer.id,
        planVersionId: input.planVersionId,
      })
    )
  }

  const apiClient = deps.createApiClient(apiKey.key)
  const usageTargets = getUsageSeedTargets(planFeatures)
  let eventsRecorded = 0

  if (usageTargets.length > 0) {
    const runResult = await apiClient.runs.start({
      customerId: customer.id,
      budgetAmountMinor: onboardingRunBudgetAmountMinor,
      idempotencyKey: `onboarding_${customer.id}_budgeted_run`,
      workloadType: "workflow",
      workloadId: "onboarding-workflow",
      traceId: `onboarding_${customer.id}`,
      metadata: {
        onboarding: true,
        planVersionId: input.planVersionId,
      },
    })

    if (runResult.error) {
      return Err(
        seedError(apiErrorMessage("Budgeted workflow run failed to start", runResult.error), {
          customerId: customer.id,
          planVersionId: input.planVersionId,
        })
      )
    }

    if (runResult.result.status !== "running") {
      return Err(
        seedError(`Budgeted workflow run did not start: ${runResult.result.status}`, {
          customerId: customer.id,
          runId: runResult.result.runId,
        })
      )
    }

    const runId = runResult.result.runId

    for (const target of usageTargets) {
      for (const [index, usage] of usageSeedValues.entries()) {
        const consumeResult = await apiClient.runs.consume({
          runId,
          featureSlug: target.featureSlug,
          eventSlug: target.eventSlug,
          idempotencyKey: `onboarding_${customer.id}_${target.featureSlug}_${index}`,
          properties: target.aggregationField ? { [target.aggregationField]: usage } : {},
        })

        if (consumeResult.error) {
          const error = seedError(
            apiErrorMessage(`Budgeted usage failed for ${target.featureSlug}`, consumeResult.error),
            {
              customerId: customer.id,
              eventSlug: target.eventSlug,
              featureSlug: target.featureSlug,
              runId,
            }
          )

          await closeStartedRunAfterFailure({
            apiClient,
            customerId: customer.id,
            logger: deps.logger,
            planVersionId: input.planVersionId,
            runId,
          })

          return Err(error)
        }

        if (!consumeResult.result.accepted) {
          const error = seedError(
            `Budgeted usage denied for ${target.featureSlug}: ${consumeResult.result.reason}`,
            {
              customerId: customer.id,
              eventSlug: target.eventSlug,
              featureSlug: target.featureSlug,
              runId,
            }
          )

          await closeStartedRunAfterFailure({
            apiClient,
            customerId: customer.id,
            logger: deps.logger,
            planVersionId: input.planVersionId,
            runId,
          })

          return Err(error)
        }

        eventsRecorded += 1
      }
    }

    const endResult = await apiClient.runs.end({
      runId,
      status: "completed",
    })

    if (endResult.error) {
      return Err(
        seedError(apiErrorMessage("Budgeted workflow run failed to close", endResult.error), {
          customerId: customer.id,
          runId,
        })
      )
    }
  }

  const verificationFeatureSlug = getVerificationFeatureSlug(planFeatures)
  let verification: SeedOnboardingEvidenceOutput["verification"] = {
    state: "skipped",
  }

  if (verificationFeatureSlug) {
    const { result, error } = await apiClient.access.check({
      customerId: customer.id,
      featureSlug: verificationFeatureSlug,
    })

    if (error) {
      return Err(
        seedError(apiErrorMessage("Access check failed", error), {
          customerId: customer.id,
          featureSlug: verificationFeatureSlug,
        })
      )
    }

    if (!result.allowed) {
      return Err(
        seedError(
          `Access check denied ${verificationFeatureSlug}${
            result.rejectionReason ? `: ${result.rejectionReason}` : ""
          }`,
          {
            customerId: customer.id,
            featureSlug: verificationFeatureSlug,
          }
        )
      )
    }

    verification = {
      state: "done",
      allowed: result.allowed,
      featureSlug: result.featureSlug,
    }
  }

  return Ok({
    state: "ok",
    apiKey: {
      id: apiKey.id,
    },
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
    },
    subscription: {
      id: subscriptionResult.val.id,
    },
    usage: {
      state: usageTargets.length > 0 ? "done" : "skipped",
      eventsRecorded,
      targetCount: usageTargets.length,
    },
    verification,
  })
}
