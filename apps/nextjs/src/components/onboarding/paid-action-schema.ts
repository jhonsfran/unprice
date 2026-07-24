import {
  eventInsertBaseSchema,
  featureInsertBaseSchema,
  paidActionPriceSchema,
} from "@unprice/db/validators"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { z } from "zod"

// Reuse the canonical feature/event/price rules so the onboarding form can
// never drift from what the server accepts.
export const paidActionFormSchema = z.object({
  title: featureInsertBaseSchema.shape.title,
  featureSlug: featureInsertBaseSchema.shape.slug,
  eventSlug: eventInsertBaseSchema.shape.slug,
  unitPrice: paidActionPriceSchema,
  unitOfMeasure: z.literal("action"),
})

// The proof shape is owned by the tRPC endpoint; derive it instead of
// redeclaring a client-side copy that could silently diverge.
type ProvePaidActionOutput = RouterOutputs["planVersions"]["provePaidAction"]

export const PROOF_PHASES = ["sandbox", "paid_action", "guardrail"] as const
export type ProofPhase = (typeof PROOF_PHASES)[number]
export type PaidActionFormValues = z.infer<typeof paidActionFormSchema>
export type ProofAction = ProvePaidActionOutput["action"]
export type ProofDecisions = ProvePaidActionOutput["decisions"]

export type AppliedTemplate = {
  key: string
  label: string
  planId?: string
  planVersionId: string
}

export type OnboardingFlowData = {
  paidAction?: PaidActionFormValues
  project?: {
    id?: string
    name?: string
    slug?: string
    defaultCurrency?: string
    timezone?: string
  }
  paymentProvider?: string
  planVersionId?: string
  templatePlansCreated?: boolean
  appliedTemplates?: AppliedTemplate[]
  apiKeyId?: string
  customer?: { customerId?: string; name?: string | null; email?: string }
  subscription?: { id?: string }
  proof?: {
    action: ProofAction
    decisions: ProofDecisions
  }
  proofPhase?: ProofPhase | "done"
  proofError?: { phase: ProofPhase; message: string }
  deniedRevealed?: boolean
  done?: boolean
}

function normalizeSlugSeed(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function derivePaidActionSlugs(title: string) {
  const featureSlug = normalizeSlugSeed(title) || "paid-action"
  return {
    featureSlug,
    eventSlug: featureSlug.replace(/-/g, "_"),
  }
}

export function normalizePaidAction(values: PaidActionFormValues): PaidActionFormValues {
  // unitPrice is already normalized by paidActionPriceSchema on parse.
  return {
    ...values,
    title: values.title.trim(),
  }
}

export function hasCompletedProof(flowData: OnboardingFlowData | undefined) {
  const proof = flowData?.proof
  if (!proof) return false

  const [allowed, denied] = proof.decisions
  return (
    allowed.accepted &&
    !denied.accepted &&
    denied.reason === "insufficient_budget" &&
    denied.consumedAmountMinor === allowed.consumedAmountMinor
  )
}

export function canCompleteOnboarding(flowData: OnboardingFlowData | undefined) {
  return flowData?.deniedRevealed === true && hasCompletedProof(flowData)
}
