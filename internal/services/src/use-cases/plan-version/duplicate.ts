import { type Database, and, eq, sql } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { PlanVersion } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"
import { isEffective } from "../../pricing"
import { type UnPriceRateCardError, versionCardName } from "../../rate-cards"
import { retainFeaturePolicies } from "../../rate-cards/catalog"
import { transactionResult } from "../../utils/transaction-result"

type DuplicatePlanVersionDeps = {
  db: Database
  logger: Logger
  services: Pick<ServiceContext, "rateCards">
}

type DuplicatePlanVersionInput = {
  id: string
  projectId: string
}

export async function duplicatePlanVersion(
  deps: DuplicatePlanVersionDeps,
  input: DuplicatePlanVersionInput
): Promise<
  Result<
    | {
        state: "not_found" | "duplicate_error"
      }
    | { state: "ok"; planVersion: PlanVersion },
    FetchError | UnPriceRateCardError
  >
> {
  const { id, projectId } = input

  deps.logger.set({
    business: {
      operation: "plan-version.duplicate",
      project_id: projectId,
    },
  })

  try {
    return await transactionResult(
      deps.db,
      async (tx): Promise<Awaited<ReturnType<typeof duplicatePlanVersion>>> => {
        await deps.services.rateCards.lockPlanVersionCards(projectId, id, tx)
        const rateCards = deps.services.rateCards.withTransaction(tx)
        const scoped = { ...deps, services: { ...deps.services, rateCards } }
        const planVersionData = await tx.query.versions.findFirst({
          where: (version, { and, eq }) =>
            and(eq(version.id, id), eq(version.projectId, projectId)),
          with: {
            planFeatures: { with: { feature: true } },
            plan: true,
          },
        })

        if (!planVersionData?.id) {
          return Ok({ state: "not_found" })
        }

        const planVersionId = newId("plan_version")
        const paymentMethodRequired = planVersionData.plan.defaultPlan
          ? false
          : planVersionData.paymentMethodRequired

        const countVersionsPlan = await tx
          .select({ count: sql<number>`count(*)` })
          .from(schema.versions)
          .where(
            and(
              eq(schema.versions.projectId, projectId),
              eq(schema.versions.planId, planVersionData.planId)
            )
          )
          .then((rows) => rows[0]?.count ?? 0)

        const duplicated = await tx
          .insert(schema.versions)
          .values({
            ...planVersionData,
            id: planVersionId,
            trialUnits: planVersionData.trialUnits,
            billingConfig: planVersionData.billingConfig,
            autoRenew: planVersionData.autoRenew,
            paymentMethodRequired,
            metadata: {},
            latest: false,
            active: true,
            // A copy is a new draft: it was never published, so its own card is not live and a
            // price change on it starts at once (ADR-0008 D2).
            status: "draft",
            publishedAt: null,
            publishedBy: null,
            archived: false,
            archivedAt: null,
            archivedBy: null,
            createdAtM: Date.now(),
            updatedAtM: Date.now(),
            version: Number(countVersionsPlan) + 1,
          })
          .returning()
          .then((rows) => rows[0] ?? null)

        if (!duplicated) return Ok({ state: "duplicate_error" })

        await Promise.all(
          planVersionData.planFeatures.map(async (feature) => {
            await tx.insert(schema.planVersionFeatures).values({
              ...feature,
              id: newId("feature_version"),
              planVersionId,
              metadata: feature.metadata,
              createdAtM: Date.now(),
              updatedAtM: Date.now(),
            })
          })
        )

        const forked = await forkCard(scoped, {
          projectId,
          planSlug: planVersionData.plan.slug,
          source: planVersionData,
          copyId: duplicated.id,
          featureSlugs: new Set(
            planVersionData.planFeatures.map((feature) => feature.feature.slug)
          ),
          now: Date.now(),
        })
        if (forked.err) return Err(forked.err)

        return Ok({
          state: "ok",
          planVersion: duplicated,
        })
      }
    )
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error))
    deps.logger.error(e, {
      context: "error duplicating plan version",
      projectId,
      planVersionId: id,
    })

    return Err(
      new FetchError({
        message: `error duplicating plan version: ${e.message}`,
        retry: false,
      })
    )
  }
}

/**
 * Gives the copy its own card inside the copy's transaction: a card named after the
 * copy with the source card's margin policy, assigned, then the source's rows in effect now
 * published on it at once (match, cost and provenance kept), so the copy's prices can change
 * without touching the customers on the source. Rows scheduled to start later are not copied: the
 * copy starts from the prices in force and schedules its own. A copy without a card in its
 * currency gets none.
 */
async function forkCard(
  deps: DuplicatePlanVersionDeps,
  input: {
    projectId: string
    planSlug: string
    source: Pick<PlanVersion, "id" | "currency">
    copyId: string
    featureSlugs: ReadonlySet<string>
    now: number
  }
): Promise<Result<void, UnPriceRateCardError | FetchError>> {
  const { rateCards } = deps.services
  const { projectId, source, copyId, now } = input
  const sourceCard = await rateCards.cardForPlanVersion(projectId, source.id, source.currency)
  if (!sourceCard) return Ok(undefined)
  const found = await rateCards.getCard(projectId, sourceCard.cardId)
  if (found.err) return Err(found.err)

  const card = await rateCards.createCard(projectId, {
    unit: `money:${source.currency}`,
    name: versionCardName(input.planSlug, copyId, source.currency),
    marginPolicy: retainFeaturePolicies(found.val.card.marginPolicy, (policy) =>
      input.featureSlugs.has(policy.featureSlug)
    ),
  })
  if (card.err) return Err(card.err)
  const assigned = await rateCards.assignToPlanVersion(projectId, {
    planVersionId: copyId,
    currency: source.currency,
    cardId: card.val.id,
  })
  if (assigned.err) return Err(assigned.err)

  const drafts = found.val.rows
    .filter((row) => input.featureSlugs.has(row.featureSlug) && isEffective(row, now))
    .map(({ featureSlug, match, price, cost, source: rowSource, sourceRef }) => ({
      featureSlug,
      match,
      price,
      cost,
      source: rowSource,
      sourceRef,
    }))
  if (drafts.length === 0) return Ok(undefined)
  const published = await rateCards.publishRows({
    projectId,
    cardId: card.val.id,
    drafts,
    now,
  })
  if (published.err) return Err(published.err)
  return Ok(undefined)
}
