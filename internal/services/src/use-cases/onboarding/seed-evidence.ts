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
import { fromZonedTime, toZonedTime } from "date-fns-tz"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import { paidActionSchema } from "../plan-template/template-data"
import { createSubscription } from "../subscription/create"

const onboardingCreditLineAmountMinor = 10_000

export const seedOnboardingEvidenceRequestSchema = z.object({
  planVersionId: z.string().min(1),
  paidAction: paidActionSchema,
})

export const seedOnboardingEvidenceInputSchema = seedOnboardingEvidenceRequestSchema.extend({
  projectId: z.string().min(1),
  projectTimezone: z.string().min(1).default("UTC"),
  projectDefaultCurrency: currencySchema.optional(),
  workspaceIsMain: z.boolean().default(false),
})

const allowedDecisionSchema = z.object({
  sequence: z.literal(1),
  accepted: z.literal(true),
  reason: z.enum(["accepted", "duplicate"]),
  consumedAmountMinor: z.number().int().nonnegative(),
  remainingAmountMinor: z.number().int().nonnegative(),
})

const deniedDecisionSchema = z.object({
  sequence: z.literal(2),
  accepted: z.literal(false),
  reason: z.literal("insufficient_budget"),
  consumedAmountMinor: z.number().int().nonnegative(),
  remainingAmountMinor: z.number().int().nonnegative(),
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
  action: z.object({
    title: z.string(),
    featureSlug: z.string(),
    eventSlug: z.string(),
    unitPriceMinor: z.number().int().positive(),
    currency: z.literal("USD"),
  }),
  decisions: z.tuple([allowedDecisionSchema, deniedDecisionSchema]),
})

export type SeedOnboardingEvidenceRequest = z.input<typeof seedOnboardingEvidenceRequestSchema>
export type SeedOnboardingEvidenceInput = z.input<typeof seedOnboardingEvidenceInputSchema>
export type SeedOnboardingEvidenceOutput = z.infer<typeof seedOnboardingEvidenceOutputSchema>

type EvidenceApiClient = {
  runs: Pick<Unprice["runs"], "start" | "consume" | "end">
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

type PaidActionTarget = {
  featureSlug: string
  eventSlug: string
}

type OnboardingCustomer = {
  id: string
  name?: string | null
  email: string
}

type OnboardingSubscription = {
  id: string
}

const unitPriceConfigSchema = z.object({
  usageMode: z.literal("unit"),
  price: z.object({
    displayAmount: z.string(),
  }),
})

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

function toCurrencyMinorAmount(amount: string) {
  return Math.round(Number(amount) * 100)
}

function getPaidActionTarget(
  planFeatures: DetailedPlanFeature[],
  paidAction: z.infer<typeof paidActionSchema>
): PaidActionTarget | null {
  const target = planFeatures.find((planFeature) => {
    const meterConfig = planFeature.meterConfig as MeterConfig | null | undefined
    return (
      planFeature.featureType === "usage" &&
      planFeature.feature?.slug === paidAction.featureSlug &&
      meterConfig?.eventSlug === paidAction.eventSlug &&
      meterConfig.aggregationMethod === "count"
    )
  })

  if (!target) {
    return null
  }

  const priceConfig = unitPriceConfigSchema.safeParse(target.config)
  if (
    !priceConfig.success ||
    Number(priceConfig.data.price.displayAmount) !== Number(paidAction.unitPrice)
  ) {
    return null
  }

  return {
    featureSlug: paidAction.featureSlug,
    eventSlug: paidAction.eventSlug,
  }
}

function normalizeCurrency(currency?: Currency) {
  return currency === "EUR" || currency === "USD" ? currency : undefined
}

function endOfCurrentDayMs(date: Date, timezone = "UTC") {
  try {
    const endOfDay = toZonedTime(date, timezone)
    endOfDay.setHours(23, 59, 59, 999)
    return fromZonedTime(endOfDay, timezone).getTime()
  } catch {
    const endOfDay = new Date(date)
    endOfDay.setUTCHours(23, 59, 59, 999)
    return endOfDay.getTime()
  }
}

function onboardingExternalId(planVersionId: string) {
  return `unprice-onboarding:${planVersionId}`
}

function isMissingActiveSubscription(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return error.code === "SUBSCRIPTION_NOT_FOUND" || error.code === "SUBSCRIPTION_NOT_ACTIVE"
}

async function getOrCreateOnboardingCustomer(
  deps: SeedOnboardingEvidenceDeps,
  input: z.infer<typeof seedOnboardingEvidenceInputSchema>
): Promise<Result<OnboardingCustomer, FetchError>> {
  const externalId = onboardingExternalId(input.planVersionId)
  const existingResult = await deps.services.customers.getCustomerByExternalId(
    input.projectId,
    externalId,
    { skipCache: true }
  )

  if (existingResult.err) {
    return Err(seedError(`Customer lookup failed: ${existingResult.err.message}`))
  }

  if (existingResult.val) {
    if (!existingResult.val.active) {
      return Err(seedError("The onboarding customer exists but is inactive."))
    }
    return Ok(existingResult.val)
  }

  const createdResult = await deps.services.customers.createCustomerRecord({
    projectId: input.projectId,
    name: "Onboarding Customer",
    email: `onboarding+${input.planVersionId}@example.com`,
    externalId,
    defaultCurrency: normalizeCurrency(input.projectDefaultCurrency),
    timezone: input.projectTimezone,
  })

  if (!createdResult.err) {
    return Ok(createdResult.val)
  }

  const racedResult = await deps.services.customers.getCustomerByExternalId(
    input.projectId,
    externalId,
    { skipCache: true }
  )
  if (!racedResult.err && racedResult.val?.active) {
    return Ok(racedResult.val)
  }

  return Err(createdResult.err)
}

async function getOrCreateOnboardingSubscription({
  creditLineAmountMinor,
  customerId,
  deps,
  input,
  now,
  planVersion,
}: {
  creditLineAmountMinor: number
  customerId: string
  deps: SeedOnboardingEvidenceDeps
  input: z.infer<typeof seedOnboardingEvidenceInputSchema>
  now: number
  planVersion: { currency: Currency; trialUnits?: number | null }
}): Promise<Result<OnboardingSubscription, FetchError>> {
  const getActiveSubscription = () =>
    deps.services.customers.getActiveSubscription({
      customerId,
      projectId: input.projectId,
      now,
      opts: { skipCache: true },
    })
  const activeResult = await getActiveSubscription()

  if (!activeResult.err) {
    if (activeResult.val.activePhase?.planVersion?.id !== input.planVersionId) {
      return Err(
        seedError("The onboarding customer already has a different active plan version.", {
          customerId,
          planVersionId: input.planVersionId,
        })
      )
    }
    return Ok({ id: activeResult.val.id })
  }

  if (!isMissingActiveSubscription(activeResult.err)) {
    return Err(seedError(`Subscription lookup failed: ${activeResult.err.message}`))
  }

  const createdResult = await createSubscription(
    {
      services: deps.services,
      db: deps.db,
      logger: deps.logger,
    },
    {
      projectId: input.projectId,
      input: {
        customerId,
        timezone: input.projectTimezone,
        phases: [
          {
            planVersionId: input.planVersionId,
            startAt: now - 5 * 60 * 1000,
            trialUnits: planVersion.trialUnits ?? 0,
            creditLinePolicy: "capped",
            creditLineAmount: toLedgerMinor(
              fromCurrencyMinor(creditLineAmountMinor, planVersion.currency)
            ),
          },
        ],
      },
    }
  )

  if (!createdResult.err) {
    return Ok({ id: createdResult.val.id })
  }

  const racedResult = await getActiveSubscription()
  if (!racedResult.err && racedResult.val.activePhase?.planVersion?.id === input.planVersionId) {
    return Ok({ id: racedResult.val.id })
  }

  return Err(
    seedError(`Subscription setup failed: ${createdResult.err.message}`, {
      customerId,
      planVersionId: input.planVersionId,
    })
  )
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
      logger.warn("failed to close onboarding budgeted run after proof error", {
        customerId,
        planVersionId,
        runId,
        error: endResult.error.message,
        code: endResult.error.code,
      })
    }
  } catch (error) {
    logger.warn("failed to close onboarding budgeted run after proof error", {
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
    return Err(seedError("Plan version not found. Please retry the Sandbox setup."))
  }
  if (planVersion.currency !== "USD") {
    return Err(seedError("The onboarding proof requires a USD Sandbox project."))
  }

  const paidAction = input.paidAction
  const unitPriceMinor = toCurrencyMinorAmount(paidAction.unitPrice)
  const planFeatures = planVersion.planFeatures as DetailedPlanFeature[]
  const target = getPaidActionTarget(planFeatures, paidAction)
  if (!target) {
    return Err(
      seedError("The saved paid action does not match the published plan version.", {
        eventSlug: paidAction.eventSlug,
        featureSlug: paidAction.featureSlug,
        planVersionId: input.planVersionId,
      })
    )
  }

  const now = Date.now()
  const apiExpiresAt = endOfCurrentDayMs(new Date(now), input.projectTimezone)
  const customerResult = await getOrCreateOnboardingCustomer(deps, input)

  if (customerResult.err) {
    return Err(customerResult.err)
  }

  const customer = customerResult.val
  const apiKeyResult = await deps.services.apikeys.createOrRollApiKey({
    projectId: input.projectId,
    name: `onboarding-${input.planVersionId}`,
    isRoot: input.workspaceIsMain,
    defaultCustomerId: customer.id,
    expiresAt: apiExpiresAt,
  })

  if (apiKeyResult.err) {
    return Err(seedError(`API key setup failed: ${apiKeyResult.err.message}`))
  }

  const apiKey = apiKeyResult.val
  const subscriptionResult = await getOrCreateOnboardingSubscription({
    creditLineAmountMinor: Math.max(onboardingCreditLineAmountMinor, unitPriceMinor),
    customerId: customer.id,
    deps,
    input,
    now,
    planVersion,
  })

  if (subscriptionResult.err) {
    return Err(subscriptionResult.err)
  }

  const apiClient = deps.createApiClient(apiKey.key)
  const runIdempotencyKey = `onboarding_${customer.id}_${paidAction.featureSlug}_proof`
  const startRun = (idempotencyKey: string) =>
    apiClient.runs.start({
      customerId: customer.id,
      budgetAmountMinor: unitPriceMinor,
      idempotencyKey,
      workloadType: "workflow",
      workloadId: "onboarding-paid-action",
      traceId: `onboarding_${customer.id}`,
      metadata: {
        onboarding: true,
        planVersionId: input.planVersionId,
        paidAction: paidAction.featureSlug,
      },
    })

  let runResult = await startRun(runIdempotencyKey)
  if (
    !runResult.error &&
    runResult.result.status !== "running" &&
    runResult.result.status !== "completed"
  ) {
    runResult = await startRun(`${runIdempotencyKey}_retry_${apiKey.updatedAtM ?? now}`)
  }

  if (runResult.error) {
    return Err(
      seedError(apiErrorMessage("Paid-action proof failed to start", runResult.error), {
        customerId: customer.id,
        planVersionId: input.planVersionId,
      })
    )
  }

  if (runResult.result.status !== "running" && runResult.result.status !== "completed") {
    return Err(
      seedError(`Paid-action proof did not start: ${runResult.result.status}`, {
        customerId: customer.id,
        runId: runResult.result.runId,
      })
    )
  }

  const runId = runResult.result.runId
  const runWasRunning = runResult.result.status === "running"
  const closeAfterFailure = async () => {
    if (!runWasRunning) return
    await closeStartedRunAfterFailure({
      apiClient,
      customerId: customer.id,
      logger: deps.logger,
      planVersionId: input.planVersionId,
      runId,
    })
  }

  const firstResult = await apiClient.runs.consume({
    runId,
    featureSlug: target.featureSlug,
    eventSlug: target.eventSlug,
    idempotencyKey: `onboarding_${runId}_${target.featureSlug}_decision_1`,
    properties: {},
  })

  if (firstResult.error) {
    await closeAfterFailure()
    return Err(
      seedError(apiErrorMessage("The paid action could not run", firstResult.error), {
        customerId: customer.id,
        runId,
      })
    )
  }

  if (!firstResult.result.accepted) {
    await closeAfterFailure()
    return Err(
      seedError(`The first paid action was denied: ${firstResult.result.reason}`, {
        customerId: customer.id,
        runId,
      })
    )
  }

  const firstReason =
    firstResult.result.reason === "duplicate" ? ("duplicate" as const) : ("accepted" as const)
  const firstDecision = {
    sequence: 1 as const,
    accepted: true as const,
    reason: firstReason,
    consumedAmountMinor: firstResult.result.run.consumedAmountMinor,
    remainingAmountMinor: firstResult.result.run.remainingAmountMinor,
  }

  if (
    firstDecision.consumedAmountMinor !== unitPriceMinor ||
    firstDecision.remainingAmountMinor !== 0
  ) {
    await closeAfterFailure()
    return Err(
      seedError("The paid action did not consume exactly the configured one-action budget.", {
        consumedAmountMinor: firstDecision.consumedAmountMinor,
        expectedAmountMinor: unitPriceMinor,
        remainingAmountMinor: firstDecision.remainingAmountMinor,
        runId,
      })
    )
  }

  const secondResult = await apiClient.runs.consume({
    runId,
    featureSlug: target.featureSlug,
    eventSlug: target.eventSlug,
    idempotencyKey: `onboarding_${runId}_${target.featureSlug}_decision_2`,
    properties: {},
  })

  if (secondResult.error) {
    await closeAfterFailure()
    return Err(
      seedError(apiErrorMessage("The guardrail request could not run", secondResult.error), {
        customerId: customer.id,
        runId,
      })
    )
  }

  if (secondResult.result.accepted) {
    await closeAfterFailure()
    return Err(
      seedError("The guardrail failed: the over-budget paid action was accepted.", {
        customerId: customer.id,
        runId,
      })
    )
  }

  if (secondResult.result.reason !== "insufficient_budget") {
    await closeAfterFailure()
    return Err(
      seedError(`The guardrail denied for an unexpected reason: ${secondResult.result.reason}`, {
        customerId: customer.id,
        runId,
      })
    )
  }

  const secondDecision = {
    sequence: 2 as const,
    accepted: false as const,
    reason: secondResult.result.reason,
    consumedAmountMinor: secondResult.result.run.consumedAmountMinor,
    remainingAmountMinor: secondResult.result.run.remainingAmountMinor,
  }

  if (secondDecision.consumedAmountMinor !== firstDecision.consumedAmountMinor) {
    await closeAfterFailure()
    return Err(
      seedError("The denied request changed the run spend.", {
        afterDeniedAmountMinor: secondDecision.consumedAmountMinor,
        beforeDeniedAmountMinor: firstDecision.consumedAmountMinor,
        runId,
      })
    )
  }

  if (runWasRunning) {
    const endResult = await apiClient.runs.end({
      runId,
      status: "completed",
    })

    if (endResult.error) {
      return Err(
        seedError(apiErrorMessage("Paid-action proof failed to close", endResult.error), {
          customerId: customer.id,
          runId,
        })
      )
    }
  }

  return Ok(
    seedOnboardingEvidenceOutputSchema.parse({
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
      action: {
        title: paidAction.title,
        featureSlug: paidAction.featureSlug,
        eventSlug: paidAction.eventSlug,
        unitPriceMinor,
        currency: "USD",
      },
      decisions: [firstDecision, secondDecision],
    })
  )
}
