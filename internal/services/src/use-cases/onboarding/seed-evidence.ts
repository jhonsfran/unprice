import type { BudgetCharge, BudgetHandle, Unprice } from "@unprice/api"
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

/** The proof budget closes after an hour, and deletes itself once closed, so none lingers. */
const PROOF_BUDGET_TTL_MS = 60 * 60 * 1000

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

/** The SDK calls the proof makes: one standalone budget, charged twice. */
export type EvidenceApiClient = {
  budgets: Pick<Unprice["budgets"], "upsert">
  budget: (key: string) => Pick<BudgetHandle, "charge">
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

type ProofBalance = Extract<BudgetCharge, { allowed: true }>["balance"]

/** What the proof budget has consumed and has left, in currency minor units. */
function spendOf(balance: ProofBalance) {
  const limit = balance.limits[0]
  return {
    consumedAmountMinor: toCurrencyMinorAmount(limit?.consumed ?? "0"),
    remainingAmountMinor: toCurrencyMinorAmount(balance.remaining ?? limit?.remaining ?? "0"),
  }
}

function deniedReason(denial: Extract<BudgetCharge, { allowed: false }>) {
  return denial.degraded ? `unavailable (${denial.blocked.error.message})` : "limit"
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

  // The proof is a standalone budget capped at one paid action: the first charge fits, the second
  // is refused. Each attempt gets its own key, so a retry never finds an earlier attempt's spend.
  const apiClient = deps.createApiClient(apiKey.key)
  const proofKey = `onboarding:${customer.id}:${paidAction.featureSlug}:${now}`
  const upsertResult = await apiClient.budgets.upsert({
    key: proofKey,
    unit: "USD",
    limits: [{ amount: paidAction.unitPrice, window: "never" }],
    closesAt: now + PROOF_BUDGET_TTL_MS,
  })

  if (upsertResult.error) {
    return Err(
      seedError(apiErrorMessage("Paid-action proof failed to start", upsertResult.error), {
        customerId: customer.id,
        planVersionId: input.planVersionId,
      })
    )
  }

  const proofBudget = apiClient.budget(proofKey)
  const charge = (sequence: 1 | 2) =>
    proofBudget.charge({
      amount: paidAction.unitPrice,
      idempotencyKey: `${proofKey}:decision_${sequence}`,
    })

  const firstResult = await charge(1)

  if (firstResult.error) {
    return Err(
      seedError(apiErrorMessage("The paid action could not run", firstResult.error), {
        customerId: customer.id,
        budgetKey: proofKey,
      })
    )
  }

  if (!firstResult.result.allowed) {
    return Err(
      seedError(`The first paid action was denied: ${deniedReason(firstResult.result)}`, {
        customerId: customer.id,
        budgetKey: proofKey,
      })
    )
  }

  const firstSpend = spendOf(firstResult.result.balance)
  const firstDecision = {
    sequence: 1 as const,
    accepted: true as const,
    reason: firstResult.result.replayed ? ("duplicate" as const) : ("accepted" as const),
    ...firstSpend,
  }

  if (
    firstDecision.consumedAmountMinor !== unitPriceMinor ||
    firstDecision.remainingAmountMinor !== 0
  ) {
    return Err(
      seedError("The paid action did not consume exactly the configured one-action budget.", {
        consumedAmountMinor: firstDecision.consumedAmountMinor,
        expectedAmountMinor: unitPriceMinor,
        remainingAmountMinor: firstDecision.remainingAmountMinor,
        budgetKey: proofKey,
      })
    )
  }

  const secondResult = await charge(2)

  if (secondResult.error) {
    return Err(
      seedError(apiErrorMessage("The guardrail request could not run", secondResult.error), {
        customerId: customer.id,
        budgetKey: proofKey,
      })
    )
  }

  if (secondResult.result.allowed) {
    return Err(
      seedError("The guardrail failed: the over-budget paid action was accepted.", {
        customerId: customer.id,
        budgetKey: proofKey,
      })
    )
  }

  if (secondResult.result.degraded) {
    return Err(
      seedError(
        `The guardrail denied for an unexpected reason: ${deniedReason(secondResult.result)}`,
        { customerId: customer.id, budgetKey: proofKey }
      )
    )
  }

  const secondDecision = {
    sequence: 2 as const,
    accepted: false as const,
    reason: "insufficient_budget" as const,
    ...spendOf(secondResult.result.balance),
  }

  if (secondDecision.consumedAmountMinor !== firstDecision.consumedAmountMinor) {
    return Err(
      seedError("The denied request changed the budget's spend.", {
        afterDeniedAmountMinor: secondDecision.consumedAmountMinor,
        beforeDeniedAmountMinor: firstDecision.consumedAmountMinor,
        budgetKey: proofKey,
      })
    )
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
