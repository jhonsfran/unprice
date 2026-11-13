import { and, asc, eq, gt, inArray, isNull, lt, or } from "@unprice/db"
import {
  features as featuresTable,
  planVersionFeatures,
  planVersionRateCards,
  plans,
  rateCardRows,
  rateCards,
  versions,
} from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import {
  type AssignPlanVersionCardInput,
  type CloseRateRowsInput,
  type CostPlusFeaturePolicy,
  type CreateRateCardInput,
  type MarginPolicy,
  type PlanVersionCard,
  type RateCard,
  type RateRow,
  type RateRowDraft,
  type publishCostPlusInputSchema,
  type publishRateRowsInputSchema,
  rateCardSchema,
  rateCardUnitSchema,
  rateRowSchema,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { formatAmount } from "@unprice/money"
import type { z } from "zod"
import type { DbExecutor, Transaction } from "../deps"
import type { ModelCostService } from "../model-costs/service"
import { type CostPlusPreview, costPlusPreview, withFeaturePolicy } from "./catalog"
import { UnPriceRateCardError } from "./errors"
import { isVersionCard } from "./price-plan-version"
import {
  type FeaturePricingSet,
  type PublishPlan,
  RATE_CHANGE_NOTICE_MS,
  type RowDraft,
  featurePricingOf,
  planClose,
  planCostPlusPublish,
  planPublish,
  planRemoveFeature,
  unionFeaturePricing,
} from "./publish"
import { toWire } from "./wire"

type RateCardServiceDeps = {
  db: DbExecutor
  modelCosts: Pick<ModelCostService, "costsAt">
}

type CardRow = typeof rateCards.$inferSelect
type RowRow = typeof rateCardRows.$inferSelect

export type PublishRowsInput = Omit<
  z.infer<typeof publishRateRowsInputSchema>,
  "rows" | "closeRowIds"
> & {
  projectId: string
  drafts: readonly (RateRowDraft & Partial<Pick<RateRow, "source" | "sourceRef">>)[]
  /** Open rows to end where the drafts start, in the same transaction (a meter regroup). */
  closeRowIds?: readonly string[]
  now: number
}

export type PublishCostPlusInput = z.infer<typeof publishCostPlusInputSchema> & {
  projectId: string
  now: number
  policy?: CostPlusFeaturePolicy
}

export type CloseRowsInput = CloseRateRowsInput & { projectId: string; now: number }

export type CloseRowsResult = {
  closed: { rowId: string; effectiveTo: number }[]
  /** Rows already closed at `effectiveTo`. */
  unchanged: number
}

export type PublishRowsResult = {
  inserted: RateRow[]
  closed: { rowId: string; effectiveTo: number }[]
  unchanged: number
}

/** A card a plan version prices with in one currency, and its rows in effect at one time. */
export type PlanVersionPricing = {
  currency: PlanVersionCard["currency"]
  card: RateCard
  rows: RateRow[]
}

/** Rate cards and their effective-dated rows (ADR-0008 D2, D3). */
export class RateCardService {
  constructor(private readonly deps: RateCardServiceDeps) {}

  /** Shares the caller's transaction. */
  withTransaction(tx: Transaction): RateCardService {
    return new RateCardService({ ...this.deps, db: tx })
  }

  async createCard(
    projectId: string,
    input: CreateRateCardInput
  ): Promise<Result<RateCard, UnPriceRateCardError>> {
    const [row] = await this.deps.db
      .insert(rateCards)
      .values({
        id: newId("rate_card"),
        projectId,
        name: input.name,
        unit: input.unit,
        creditValueUsd:
          input.creditValueUsd === undefined ? null : formatAmount(input.creditValueUsd),
        marginPolicy: toWire<CardRow["marginPolicy"]>(input.marginPolicy),
      })
      .onConflictDoNothing({ target: [rateCards.projectId, rateCards.name] })
      .returning()
    if (!row) return Err(new UnPriceRateCardError({ code: "CARD_NAME_TAKEN", name: input.name }))
    return Ok(toRateCard(row))
  }

  /** The project's card named `name`, or null when it has none. */
  async cardByName(projectId: string, name: string): Promise<RateCard | null> {
    const [row] = await this.deps.db
      .select()
      .from(rateCards)
      .where(and(eq(rateCards.projectId, projectId), eq(rateCards.name, name)))
    return row ? toRateCard(row) : null
  }

  async listCards(projectId: string) {
    const rows = await this.deps.db
      .select()
      .from(rateCards)
      .where(eq(rateCards.projectId, projectId))
      .orderBy(asc(rateCards.name))
    const assigned = await this.deps.db
      .select({
        planSlug: plans.slug,
        planVersionId: versions.id,
        currency: planVersionRateCards.currency,
        planTitle: plans.title,
        version: versions.version,
      })
      .from(planVersionRateCards)
      .innerJoin(
        versions,
        and(
          eq(versions.projectId, planVersionRateCards.projectId),
          eq(versions.id, planVersionRateCards.planVersionId)
        )
      )
      .innerJoin(plans, and(eq(plans.projectId, versions.projectId), eq(plans.id, versions.planId)))
      .where(eq(planVersionRateCards.projectId, projectId))
    return rows.map((row) => ({
      ...toRateCard(row),
      version: assigned.find((version) => isVersionCard(row, version)) ?? null,
    }))
  }

  /** The card's full row history and liveness from one database snapshot. */
  async getCard(
    projectId: string,
    cardId: string
  ): Promise<Result<{ card: RateCard; rows: RateRow[]; live: boolean }, UnPriceRateCardError>> {
    const found = await this.deps.db.query.rateCards.findFirst({
      where: and(eq(rateCards.projectId, projectId), eq(rateCards.id, cardId)),
      with: {
        rows: {
          orderBy: [
            asc(rateCardRows.featureSlug),
            asc(rateCardRows.effectiveFrom),
            asc(rateCardRows.id),
          ],
        },
      },
      extras: (card, { sql }) => ({
        live: sql<boolean>`exists (
          select 1 from ${planVersionRateCards} as assignment
          inner join ${versions} as version on version.id = assignment.plan_version_id
            and version.project_id = assignment.project_id
          where assignment.rate_card_id = ${card.id}
            and assignment.project_id = ${card.projectId}
            and version.${sql.identifier(versions.publishedAt.name)} is not null
        )`.as("live"),
      }),
    })
    if (!found) return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId }))
    return Ok({ card: toRateCard(found), rows: found.rows.map(toRateRow), live: found.live })
  }

  /**
   * Prices a draft plan version in `currency` with a card (ADR-0008 D2), replacing the card it had
   * in that currency. A published version's cards are part of its package. A money card must be in
   * the currency it prices. A credits card is refused: invoices are in money, so billing could never
   * invoice a subscription on it.
   */
  async assignToPlanVersion(
    projectId: string,
    input: AssignPlanVersionCardInput
  ): Promise<Result<PlanVersionCard, UnPriceRateCardError>> {
    const { planVersionId, currency, cardId } = input
    return this.deps.db.transaction(
      async (tx): Promise<Result<PlanVersionCard, UnPriceRateCardError>> => {
        const version = await lockPlanVersion(tx, projectId, planVersionId)
        if (!version) {
          return Err(new UnPriceRateCardError({ code: "PLAN_VERSION_NOT_FOUND", planVersionId }))
        }
        if (version.status === "published") {
          return Err(new UnPriceRateCardError({ code: "PLAN_VERSION_PUBLISHED", planVersionId }))
        }
        const [card] = await tx
          .select({ unit: rateCards.unit })
          .from(rateCards)
          .where(and(eq(rateCards.projectId, projectId), eq(rateCards.id, cardId)))
          .for("update")
        if (!card) return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId }))
        if (card.unit !== `money:${currency}`) {
          return Err(
            new UnPriceRateCardError({
              code: "CARD_UNIT_MISMATCH",
              cardId,
              unit: card.unit,
              currency,
            })
          )
        }
        await tx
          .insert(planVersionRateCards)
          .values({
            id: newId("plan_version_rate_card"),
            projectId,
            planVersionId,
            currency,
            rateCardId: cardId,
          })
          .onConflictDoUpdate({
            target: [
              planVersionRateCards.projectId,
              planVersionRateCards.planVersionId,
              planVersionRateCards.currency,
            ],
            set: { rateCardId: cardId, updatedAt: new Date() },
          })
        return Ok({ planVersionId, currency, cardId, unit: rateCardUnitSchema.parse(card.unit) })
      }
    )
  }

  /** The card a plan version prices with in `currency`, or null when it has none. */
  async cardForPlanVersion(
    projectId: string,
    planVersionId: string,
    currency: PlanVersionCard["currency"]
  ): Promise<PlanVersionCard | null> {
    const [row] = await this.deps.db
      .select({ cardId: planVersionRateCards.rateCardId, unit: rateCards.unit })
      .from(planVersionRateCards)
      .innerJoin(
        rateCards,
        and(
          eq(rateCards.projectId, planVersionRateCards.projectId),
          eq(rateCards.id, planVersionRateCards.rateCardId)
        )
      )
      .where(
        and(
          eq(planVersionRateCards.projectId, projectId),
          eq(planVersionRateCards.planVersionId, planVersionId),
          eq(planVersionRateCards.currency, currency)
        )
      )
    if (!row) return null
    return { planVersionId, currency, cardId: row.cardId, unit: rateCardUnitSchema.parse(row.unit) }
  }

  /**
   * The cards each version prices with. A numeric end selects rows overlapping [at, until);
   * `{ scheduled: true }` also includes every future row. A version without a card is absent.
   */
  async pricingForPlanVersions(
    projectId: string,
    planVersionIds: readonly string[],
    at: number,
    until: number | { scheduled: true } = at + 1
  ): Promise<Map<string, PlanVersionPricing[]>> {
    const byVersion = new Map<string, PlanVersionPricing[]>()
    if (planVersionIds.length === 0) return byVersion
    const assigned = await this.deps.db
      .select({ assignment: planVersionRateCards, card: rateCards })
      .from(planVersionRateCards)
      .innerJoin(
        rateCards,
        and(
          eq(rateCards.projectId, planVersionRateCards.projectId),
          eq(rateCards.id, planVersionRateCards.rateCardId)
        )
      )
      .where(
        and(
          eq(planVersionRateCards.projectId, projectId),
          inArray(planVersionRateCards.planVersionId, [...planVersionIds])
        )
      )
      .orderBy(asc(planVersionRateCards.currency))
    const rows = await this.getEffectiveRows({
      projectId,
      cardIds: [...new Set(assigned.map(({ card }) => card.id))],
      from: at,
      to: typeof until === "number" ? until : undefined,
    })
    for (const { assignment, card } of assigned) {
      const pricing = byVersion.get(assignment.planVersionId) ?? []
      pricing.push({
        currency: assignment.currency,
        card: toRateCard(card),
        rows: rows.filter((row) => row.rateCardId === card.id),
      })
      byVersion.set(assignment.planVersionId, pricing)
    }
    return byVersion
  }

  /**
   * Each version's rows in effect at `at` on its card in the version's own currency; empty for a
   * version without one. What a pricing card or plan editor shows as the price.
   */
  async rowsForVersions(
    projectId: string,
    planVersions: readonly { id: string; currency: PlanVersionCard["currency"] }[],
    at: number
  ): Promise<Map<string, RateRow[]>> {
    const pricing = await this.pricingForPlanVersions(
      projectId,
      planVersions.map((version) => version.id),
      at
    )
    return new Map(
      planVersions.map((version) => [
        version.id,
        pricing.get(version.id)?.find((card) => card.currency === version.currency)?.rows ?? [],
      ])
    )
  }

  /** The rows of `cardIds` whose interval overlaps [from, to). */
  async getEffectiveRows(input: {
    projectId: string
    cardIds: readonly string[]
    from: number
    to?: number
    /** A transaction that holds the cards' locks, so the rows read are the rows that count. */
    executor?: DbExecutor
  }): Promise<RateRow[]> {
    if (input.cardIds.length === 0) return []
    const rows = await (input.executor ?? this.deps.db)
      .select()
      .from(rateCardRows)
      .where(
        and(
          eq(rateCardRows.projectId, input.projectId),
          inArray(rateCardRows.rateCardId, [...input.cardIds]),
          input.to === undefined ? undefined : lt(rateCardRows.effectiveFrom, input.to),
          or(isNull(rateCardRows.effectiveTo), gt(rateCardRows.effectiveTo, input.from))
        )
      )
      .orderBy(
        asc(rateCardRows.rateCardId),
        asc(rateCardRows.featureSlug),
        asc(rateCardRows.effectiveFrom),
        asc(rateCardRows.id)
      )
    return rows.map(toRateRow)
  }

  /** Publishes drafts on a card; see `planPublish` for the rules. */
  async publishRows(
    input: PublishRowsInput
  ): Promise<Result<PublishRowsResult, UnPriceRateCardError>> {
    return this.withLockedCard(input.projectId, input.cardId, async (locked) => {
      return writePublish(
        locked,
        input,
        input.drafts.map((draft) => ({
          ...draft,
          source: draft.source ?? "manual",
          sourceRef: draft.sourceRef ?? null,
        }))
      )
    })
  }

  /**
   * Publishes the added and changed rows of a card's cost-plus revision, recomputed at `now`
   * under the card's lock. A revision with nothing to write, such as a retry of a publish that
   * succeeded, writes nothing and succeeds whatever hash it carries. Otherwise a draft that
   * differs from the one the caller previewed is DRAFT_STALE and writes nothing.
   */
  async publishCostPlus(
    input: PublishCostPlusInput
  ): Promise<Result<PublishRowsResult, UnPriceRateCardError>> {
    return this.withLockedCard(input.projectId, input.cardId, async (locked) => {
      const plan = planCostPlusPublish({
        ...input,
        card: locked.card,
        rows: locked.rows,
        noticeMs: locked.noticeMs,
        ...locked.featurePricing,
        costs: await this.deps.modelCosts.costsAt(input.projectId, input.now),
        newRowId: () => newId("rate_card_row"),
      })
      if (plan.err) return Err(plan.err)
      const result = await writePublishPlan(locked.tx, input.projectId, plan.val)
      if (input.policy)
        await writeMarginPolicy(locked.tx, input.projectId, input.cardId, plan.val.marginPolicy)
      return Ok(result)
    })
  }

  /**
   * Ends open rows at `effectiveTo`, the earliest the card allows when absent; see `planClose`
   * for the rules.
   */
  async closeRows(input: CloseRowsInput): Promise<Result<CloseRowsResult, UnPriceRateCardError>> {
    return this.withLockedCard(input.projectId, input.cardId, async ({ tx, rows, noticeMs }) => {
      const plan = planClose({
        rows,
        rowIds: input.rowIds,
        effectiveTo: input.effectiveTo,
        now: input.now,
        noticeMs,
      })
      if (plan.err) return Err(plan.err)
      const rowIds = plan.val.closes.map((close) => close.rowId)
      await closeOpenRows(tx, input.projectId, rowIds, plan.val.effectiveTo)
      return Ok({ closed: [...plan.val.closes], unchanged: plan.val.unchanged })
    })
  }

  /** Ends prices and drops the policy only when no assigned version carries the feature. */
  async removeFeaturePrices(input: {
    projectId: string
    cardId: string
    featureSlug: string
    now: number
  }): Promise<Result<void, UnPriceRateCardError>> {
    return this.withLockedCard(
      input.projectId,
      input.cardId,
      async ({ tx, card, rows, noticeMs, assigned, featurePricing }) => {
        const plan = planRemoveFeature({
          ...input,
          card,
          rows,
          noticeMs,
          assigned: assigned ? featurePricing : null,
        })
        if (plan.err) return Err(plan.err)
        if (!plan.val) return Ok(undefined)
        await closeOpenRows(
          tx,
          input.projectId,
          plan.val.closes.map((close) => close.rowId),
          plan.val.effectiveTo
        )
        await writeMarginPolicy(tx, input.projectId, input.cardId, plan.val.marginPolicy)
        return Ok(undefined)
      }
    )
  }

  /**
   * The cost-plus revision at the supplied clock. A hypothetical `options.at` has no publishable
   * hash. Every proposed row's sourceRef identifies its cost row.
   */
  async previewCostPlus(
    projectId: string,
    cardId: string,
    now: number,
    /** A feature policy to draft with instead of the saved one; nothing is written. */
    options?: { at?: number; policy?: CostPlusFeaturePolicy; featureSlug?: string }
  ): Promise<
    Result<Omit<CostPlusPreview, "draftHash"> & { draftHash: string | null }, UnPriceRateCardError>
  > {
    const found = await this.getCard(projectId, cardId)
    if (found.err) return Err(found.err)
    const { card, rows } = found.val
    const drafted = options?.policy
      ? { ...card, marginPolicy: withFeaturePolicy(card.marginPolicy, options.policy) }
      : card
    const preview = costPlusPreview(
      drafted,
      rows,
      await this.deps.modelCosts.costsAt(projectId, options?.at ?? now),
      options?.at ?? now,
      options?.featureSlug
    )
    if (preview.err) return Err(preview.err)
    return Ok({
      ...preview.val,
      draftHash: options?.at === undefined ? preview.val.draftHash : null,
    })
  }

  /**
   * The plan versions that price with a card, one per currency assignment. A card is live once any
   * of them has been published (`publishedAt` survives later edits), because a published version
   * is the only way a subscription, and so a budget, reaches the card.
   */
  async versionsPricingWith(
    projectId: string,
    cardId: string,
    executor: DbExecutor = this.deps.db
  ): Promise<
    { planVersionId: string; currency: PlanVersionCard["currency"]; publishedAt: number | null }[]
  > {
    const assigned = await executor
      .select({
        planVersionId: planVersionRateCards.planVersionId,
        currency: planVersionRateCards.currency,
        publishedAt: versions.publishedAt,
      })
      .from(planVersionRateCards)
      .innerJoin(
        versions,
        and(
          eq(versions.projectId, planVersionRateCards.projectId),
          eq(versions.id, planVersionRateCards.planVersionId)
        )
      )
      .where(
        and(
          eq(planVersionRateCards.projectId, projectId),
          eq(planVersionRateCards.rateCardId, cardId)
        )
      )
    return assigned.map((row) => ({ ...row, publishedAt: row.publishedAt ?? null }))
  }

  /**
   * Whether a budget may price with the card: a version that has been published prices with it
   * (ADR-0008 D2). Read under the card's lock, it decides the notice a row change takes.
   */
  async isLive(projectId: string, cardId: string, executor: DbExecutor = this.deps.db) {
    const versions = await this.versionsPricingWith(projectId, cardId, executor)
    return versions.some((version) => version.publishedAt !== null)
  }

  /**
   * The features the card prices for: the union of the plan features of every version assigned
   * to it, each read through its own meter snapshot (`featurePricingOf`). Null while no version
   * prices with the card, when the project's features are all the card can be checked against.
   */
  async featuresPricingWith(
    projectId: string,
    cardId: string,
    executor: DbExecutor = this.deps.db
  ): Promise<FeaturePricingSet | null> {
    const assigned = await executor
      .select({
        slug: featuresTable.slug,
        meterConfig: planVersionFeatures.meterConfig,
        included: planVersionFeatures.included,
      })
      .from(planVersionRateCards)
      .leftJoin(
        planVersionFeatures,
        and(
          eq(planVersionFeatures.projectId, planVersionRateCards.projectId),
          eq(planVersionFeatures.planVersionId, planVersionRateCards.planVersionId)
        )
      )
      .leftJoin(
        featuresTable,
        and(
          eq(featuresTable.projectId, planVersionFeatures.projectId),
          eq(featuresTable.id, planVersionFeatures.featureId)
        )
      )
      .where(
        and(
          eq(planVersionRateCards.projectId, projectId),
          eq(planVersionRateCards.rateCardId, cardId)
        )
      )
    if (assigned.length === 0) return null
    return unionFeaturePricing(
      assigned.flatMap((row) =>
        row.slug === null
          ? []
          : [
              featurePricingOf({
                slug: row.slug,
                meterConfig: row.meterConfig,
                included: row.included,
              }),
            ]
      )
    )
  }

  /**
   * Takes the row lock of every card a plan version prices with, inside the caller's transaction,
   * so a row write on one of them and the version's publish serialize: whichever commits second
   * sees the other's rows, or the other's `publishedAt`.
   */
  async lockPlanVersionCards(
    projectId: string,
    planVersionId: string,
    tx: Transaction
  ): Promise<string[]> {
    await lockPlanVersion(tx, projectId, planVersionId)
    const locked = await tx
      .select({ id: rateCards.id })
      .from(rateCards)
      .innerJoin(
        planVersionRateCards,
        and(
          eq(planVersionRateCards.projectId, rateCards.projectId),
          eq(planVersionRateCards.rateCardId, rateCards.id)
        )
      )
      .where(
        and(
          eq(planVersionRateCards.projectId, projectId),
          eq(planVersionRateCards.planVersionId, planVersionId)
        )
      )
      .orderBy(asc(rateCards.id))
      .for("update", { of: rateCards })
    return locked.map((row) => row.id)
  }

  private async cardRows(
    executor: DbExecutor,
    projectId: string,
    cardId: string
  ): Promise<RateRow[]> {
    const rows = await executor
      .select()
      .from(rateCardRows)
      .where(and(eq(rateCardRows.projectId, projectId), eq(rateCardRows.rateCardId, cardId)))
      .orderBy(asc(rateCardRows.featureSlug), asc(rateCardRows.effectiveFrom), asc(rateCardRows.id))
    return rows.map(toRateRow)
  }

  /**
   * Runs `write` in one transaction that holds the card's row lock, so two writes on a card never
   * plan against the same rows, and a publish of a version that prices with the card (which takes
   * the same lock) never slips between reading whether the card is live and writing.
   */
  private async withLockedCard<T>(
    projectId: string,
    cardId: string,
    write: (locked: LockedCard) => Promise<Result<T, UnPriceRateCardError>>
  ): Promise<Result<T, UnPriceRateCardError>> {
    return this.deps.db.transaction(async (tx) => {
      const [card] = await tx
        .select()
        .from(rateCards)
        .where(and(eq(rateCards.projectId, projectId), eq(rateCards.id, cardId)))
        .for("update")
      if (!card) return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId }))
      const live = await this.isLive(projectId, cardId, tx)
      const assigned = await this.featuresPricingWith(projectId, cardId, tx)
      const featurePricing =
        assigned ??
        unionFeaturePricing(
          (await tx.select().from(featuresTable).where(eq(featuresTable.projectId, projectId))).map(
            (feature) => featurePricingOf(feature)
          )
        )
      return write({
        featurePricing,
        assigned: assigned !== null,
        tx,
        card: toRateCard(card),
        rows: await this.cardRows(tx, projectId, cardId),
        noticeMs: live ? RATE_CHANGE_NOTICE_MS : 0,
      })
    })
  }
}

/** A card under its row lock: the card, every row it has, and the notice a change on it takes. */
type LockedCard = Readonly<{
  tx: Transaction
  card: RateCard
  rows: RateRow[]
  noticeMs: number
  featurePricing: FeaturePricingSet
  assigned: boolean
}>

async function writePublish(
  { tx, card, rows, noticeMs, featurePricing }: LockedCard,
  input: Omit<PublishRowsInput, "drafts" | "cardId">,
  drafts: readonly RowDraft[]
): Promise<Result<PublishRowsResult, UnPriceRateCardError>> {
  const plan = planPublish({
    card,
    rows,
    drafts,
    closeRowIds: input.closeRowIds,
    effectiveFrom: input.effectiveFrom,
    now: input.now,
    noticeMs,
    ...featurePricing,
    newRowId: () => newId("rate_card_row"),
  })
  if (plan.err) return Err(plan.err)
  return Ok(await writePublishPlan(tx, input.projectId, plan.val))
}

async function writePublishPlan(
  tx: Transaction,
  projectId: string,
  plan: PublishPlan
): Promise<PublishRowsResult> {
  await closeOpenRows(
    tx,
    projectId,
    plan.closes.map((close) => close.rowId),
    plan.effectiveFrom
  )
  if (plan.inserts.length > 0) {
    await tx.insert(rateCardRows).values(plan.inserts.map((row) => toInsert(projectId, row)))
  }
  return { inserted: [...plan.inserts], closed: [...plan.closes], unchanged: plan.unchanged }
}

/** Ends open rows at `effectiveTo` in one statement. The caller holds the card's lock. */
async function closeOpenRows(
  tx: Transaction,
  projectId: string,
  rowIds: readonly string[],
  effectiveTo: number
): Promise<void> {
  if (rowIds.length === 0) return
  const closed = await tx
    .update(rateCardRows)
    .set({ effectiveTo })
    .where(
      and(
        eq(rateCardRows.projectId, projectId),
        inArray(rateCardRows.id, [...rowIds]),
        isNull(rateCardRows.effectiveTo)
      )
    )
    .returning({ id: rateCardRows.id })
  if (closed.length !== rowIds.length) {
    throw new Error(`${rowIds.length - closed.length} of ${rowIds.length} rate rows are not open`)
  }
}

function toRateCard(row: CardRow): RateCard {
  return rateCardSchema.parse({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    unit: row.unit,
    creditValueUsd: row.creditValueUsd ?? undefined,
    marginPolicy: row.marginPolicy,
  })
}

function toRateRow(row: RowRow): RateRow {
  return rateRowSchema.parse({
    id: row.id,
    rateCardId: row.rateCardId,
    featureSlug: row.featureSlug,
    match: row.match,
    price: row.price,
    cost: row.cost,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    source: row.source,
    sourceRef: row.sourceRef,
  })
}

function toInsert(projectId: string, row: RateRow): typeof rateCardRows.$inferInsert {
  return {
    id: row.id,
    projectId,
    rateCardId: row.rateCardId,
    featureSlug: row.featureSlug,
    match: row.match,
    price: toWire<RowRow["price"]>(row.price),
    cost: row.cost === null ? null : toWire<NonNullable<RowRow["cost"]>>(row.cost),
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    source: row.source,
    sourceRef: row.sourceRef,
  }
}

async function writeMarginPolicy(
  tx: Transaction,
  projectId: string,
  cardId: string,
  marginPolicy: MarginPolicy
) {
  await tx
    .update(rateCards)
    .set({ marginPolicy: toWire<CardRow["marginPolicy"]>(marginPolicy), updatedAt: new Date() })
    .where(and(eq(rateCards.projectId, projectId), eq(rateCards.id, cardId)))
}

/** Plan, version, then card locks: publishing also updates the plan's previous latest version. */
async function lockPlanVersion(tx: Transaction, projectId: string, planVersionId: string) {
  const [target] = await tx
    .select({ planId: versions.planId })
    .from(versions)
    .where(and(eq(versions.projectId, projectId), eq(versions.id, planVersionId)))
  if (!target) return undefined
  await tx
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.projectId, projectId), eq(plans.id, target.planId)))
    .for("update")
  const [version] = await tx
    .select({ status: versions.status })
    .from(versions)
    .where(and(eq(versions.projectId, projectId), eq(versions.id, planVersionId)))
    .for("update")
  return version
}
