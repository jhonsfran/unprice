import type { Unprice } from "@unprice/api"
import type { Database } from "@unprice/db"
import { currencySchema, paidActionSchema } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import { setProviderEnabled } from "../payment-provider/connection"
import { appliedPlanTemplateSchema, applyPlanTemplate } from "../plan-template/apply"
import { seedOnboardingEvidence, seedOnboardingEvidenceOutputSchema } from "./seed-evidence"

// One atomic onboarding step. The client creates the Sandbox project (that call
// is workspace-scoped and mints a fresh project), then hands the project here to
// enable the provider, publish the paid-action plan, and run the two-decision
// proof. Every operation below is idempotent, so a retry from the client re-runs
// the whole thing safely instead of threading half-finished state.
export const runPaidActionProofRequestSchema = z.object({
  paidAction: paidActionSchema,
})

export const runPaidActionProofInputSchema = runPaidActionProofRequestSchema.extend({
  projectId: z.string().min(1),
  projectTimezone: z.string().min(1).default("UTC"),
  projectDefaultCurrency: currencySchema.optional(),
  workspaceIsMain: z.boolean().default(false),
  workspaceUnPriceCustomerId: z.string().min(1),
})

export const runPaidActionProofOutputSchema = seedOnboardingEvidenceOutputSchema.extend({
  paymentProvider: z.string(),
  planVersionId: z.string(),
  appliedTemplates: z.array(appliedPlanTemplateSchema),
})

export type RunPaidActionProofRequest = z.input<typeof runPaidActionProofRequestSchema>
export type RunPaidActionProofInput = z.input<typeof runPaidActionProofInputSchema>
export type RunPaidActionProofOutput = z.infer<typeof runPaidActionProofOutputSchema>

type RunPaidActionProofDeps = {
  services: Pick<
    ServiceContext,
    "plans" | "features" | "events" | "customers" | "apikeys" | "subscriptions" | "billing"
  >
  db: Database
  logger: Logger
  userId: string
  createApiClient: (token: string) => { runs: Pick<Unprice["runs"], "start" | "consume" | "end"> }
}

export async function runPaidActionProof(
  deps: RunPaidActionProofDeps,
  rawInput: RunPaidActionProofInput
): Promise<Result<RunPaidActionProofOutput, FetchError>> {
  const input = runPaidActionProofInputSchema.parse(rawInput)

  deps.logger.set({
    business: {
      operation: "onboarding.run-paid-action-proof",
      project_id: input.projectId,
    },
  })

  const providerResult = await setProviderEnabled(
    { db: deps.db, logger: deps.logger },
    { projectId: input.projectId, paymentProvider: "sandbox", enabled: true }
  )
  if (providerResult.err) return Err(providerResult.err)
  const paymentProvider = providerResult.val.paymentProviderConfig?.paymentProvider ?? "sandbox"

  const templateResult = await applyPlanTemplate(
    {
      services: deps.services,
      db: deps.db,
      logger: deps.logger,
      userId: deps.userId,
    },
    {
      template: "saas_onboarding",
      currency: "USD",
      paymentProvider: "sandbox",
      publish: true,
      paidAction: input.paidAction,
      projectId: input.projectId,
      workspaceUnPriceCustomerId: input.workspaceUnPriceCustomerId,
    }
  )
  if (templateResult.err) return Err(templateResult.err)
  if (templateResult.val.state !== "ok") {
    return Err(
      new FetchError({
        message: `The Sandbox plan could not be prepared: ${templateResult.val.state}`,
        retry: false,
      })
    )
  }
  const { primaryPlanVersionId, appliedTemplates } = templateResult.val

  const evidenceResult = await seedOnboardingEvidence(
    {
      services: deps.services,
      db: deps.db,
      logger: deps.logger,
      createApiClient: deps.createApiClient,
    },
    {
      planVersionId: primaryPlanVersionId,
      paidAction: input.paidAction,
      projectId: input.projectId,
      projectTimezone: input.projectTimezone,
      projectDefaultCurrency: input.projectDefaultCurrency,
      workspaceIsMain: input.workspaceIsMain,
    }
  )
  if (evidenceResult.err) return Err(evidenceResult.err)

  return Ok(
    runPaidActionProofOutputSchema.parse({
      ...evidenceResult.val,
      paymentProvider,
      planVersionId: primaryPlanVersionId,
      appliedTemplates,
    })
  )
}
