import { and, asc, eq, lte } from "@unprice/db"
import { customModelCosts, modelCosts } from "@unprice/db/schema"
import {
  type CostPlusFeaturePolicy,
  type CustomModelCost,
  type MarginPolicy,
  type ModelCost,
  type RateCard,
  type RateRow,
  customModelCostSchema,
  modelCostSchema,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { DbExecutor } from "../deps"
import { type CostPlusCard, type CostPlusDraft, costPlusRevision, writesRow } from "../pricing"
import { UnPriceRateCardError } from "./errors"
import { canonicalJson, stableHash } from "./wire"

type CostPlusPreview = { draft: CostPlusDraft; draftHash: string }
export async function costPlusPreview(
  executor: DbExecutor,
  card: RateCard,
  rows: readonly RateRow[],
  at: number,
  featureSlug?: string
): Promise<Result<CostPlusPreview, UnPriceRateCardError>> {
  if (card.marginPolicy.type !== "costPlus") {
    return Err(new UnPriceRateCardError({ code: "NOT_COST_PLUS", cardId: card.id }))
  }
  const costRows = await executor
    .select()
    .from(modelCosts)
    .where(lte(modelCosts.effectiveFrom, at))
    .orderBy(
      asc(modelCosts.provider),
      asc(modelCosts.model),
      asc(modelCosts.source),
      asc(modelCosts.effectiveFrom),
      asc(modelCosts.id)
    )
  // The card's project's own costs rank as manual, so they outrank the models.dev import of the
  // same model, and stay inside the project.
  const customRows = await executor
    .select()
    .from(customModelCosts)
    .where(
      and(eq(customModelCosts.projectId, card.projectId), lte(customModelCosts.effectiveFrom, at))
    )
    .orderBy(
      asc(customModelCosts.provider),
      asc(customModelCosts.model),
      asc(customModelCosts.effectiveFrom),
      asc(customModelCosts.id)
    )
  // costPlusRevision copies a cost's sourceRef onto its proposed row, and a catalog row
  // references the cost row it was priced from.
  const costs = [
    ...costRows.map((row) => ({ ...toModelCost(row), sourceRef: row.id })),
    ...customRows.map((row) => customAsModelCost(toCustomModelCost(row))),
  ]
  const costPlusCard: CostPlusCard = {
    ...card,
    marginPolicy: {
      ...card.marginPolicy,
      features: card.marginPolicy.features.filter(
        (policy) => featureSlug === undefined || policy.featureSlug === featureSlug
      ),
    },
  }
  const draft = costPlusRevision(costPlusCard, costs, rows, at)
  return Ok({ draft, draftHash: draftHash(draft) })
}

type ModelCostRow = typeof modelCosts.$inferSelect
type CustomModelCostRow = typeof customModelCosts.$inferSelect

export function toCustomModelCost(row: CustomModelCostRow): CustomModelCost {
  return customModelCostSchema.parse({
    id: row.id,
    provider: row.provider,
    model: row.model,
    components: row.components,
    effectiveFrom: row.effectiveFrom,
  })
}

/** Hashes what publishing the draft would write, so a stale preview cannot be published. */
export function draftHash(draft: CostPlusDraft): string {
  return stableHash({
    cardId: draft.cardId,
    changes: draft.changes.filter(writesRow).map((change) => ({
      type: change.type,
      current: change.type === "changed" ? change.current.id : null,
      proposed: change.proposed,
    })),
  })
}

export function toModelCost(row: ModelCostRow): ModelCost {
  return modelCostSchema.parse({
    provider: row.provider,
    model: row.model,
    components: row.components,
    effectiveFrom: row.effectiveFrom,
    source: row.source,
    sourceRef: row.sourceRef,
  })
}

/** A project's cost as the cost-plus revision reads costs: manual, referencing its own row. */
export function customAsModelCost(cost: CustomModelCost): ModelCost {
  return {
    provider: cost.provider,
    model: cost.model,
    components: Object.fromEntries(
      Object.entries(cost.components).filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined
      )
    ),
    effectiveFrom: cost.effectiveFrom,
    source: "manual",
    sourceRef: cost.id,
  }
}

/** A card's margin policy with one feature's cost-plus policy set: one policy per feature. */
export function withFeaturePolicy(
  marginPolicy: RateCard["marginPolicy"],
  policy: CostPlusFeaturePolicy
): RateCard["marginPolicy"] {
  const kept =
    marginPolicy.type === "costPlus"
      ? marginPolicy.features.filter((other) => other.featureSlug !== policy.featureSlug)
      : []
  return { type: "costPlus", features: [...kept, policy] }
}

export function retainFeaturePolicies(
  policy: MarginPolicy,
  keep: (feature: CostPlusFeaturePolicy) => boolean
): MarginPolicy {
  if (policy.type === "manual") return policy
  const features = policy.features.filter(keep)
  return features.length > 0 ? { type: "costPlus", features } : { type: "manual" }
}

export function hasFeaturePolicy(
  marginPolicy: MarginPolicy,
  policy: CostPlusFeaturePolicy
): boolean {
  return (
    marginPolicy.type === "costPlus" &&
    marginPolicy.features.some((saved) => canonicalJson(saved) === canonicalJson(policy))
  )
}
