import { Err, Ok } from "@unprice/error"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import { versionReadiness } from "../../pricing"
import { isVersionCard } from "../../rate-cards"

const getPlanVersionPricingInputSchema = z.object({
  projectId: z.string(),
  planVersionId: z.string(),
  now: z.number().int().nonnegative(),
})

/** The editor reads the same currency and readiness rule as publish. */
export async function getPlanVersionPricing(
  { services }: { services: Pick<ServiceContext, "plans" | "rateCards"> },
  input: z.infer<typeof getPlanVersionPricingInputSchema>
) {
  const found = await services.plans.getPlanVersionByIdDetailed({
    projectId: input.projectId,
    planVersionId: input.planVersionId,
  })
  if (found.err) return Err(found.err)
  if (!found.val) return Ok({ cards: [], hasCard: false, unpricedFeatureSlugs: [] })
  const version = found.val
  const pricing = await services.rateCards.pricingForPlanVersions(
    input.projectId,
    [version.id],
    input.now,
    { scheduled: true }
  )
  const cards = (pricing.get(version.id) ?? []).map((entry) => ({
    ...entry,
    own: isVersionCard(entry.card, {
      planSlug: version.plan.slug,
      planVersionId: version.id,
      currency: entry.currency,
    }),
  }))
  return Ok({
    cards,
    ...versionReadiness(
      version.planFeatures,
      cards.find((entry) => entry.currency === version.currency),
      input.now
    ),
  })
}
