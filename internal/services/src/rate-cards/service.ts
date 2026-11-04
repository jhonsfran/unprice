import { type Database, and, asc, desc, eq, gt, inArray, isNull, lt, lte, or } from "@unprice/db"
import { modelCosts, rateCardRows, rateCards } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import {
  type CloseRateRowsInput,
  type CreateRateCardInput,
  type FeaturePricing,
  type ModelCost,
  type RateCard,
  type RateRow,
  modelCostSchema,
  rateCardSchema,
  rateRowSchema,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { formatAmount } from "@unprice/money"
import type { DbExecutor, Transaction } from "../deps"
import { type CostPlusCard, type CostPlusDraft, costPlusRevision, writesRow } from "../pricing"
import { UnPriceRateCardError, type UnpriceableFeature } from "./errors"
import { type RowDraft, planClose, planPublish } from "./publish"
import { stableHash, toWire } from "./wire"

type RateCardServiceDeps = {
  db: Database
}

type CardRow = typeof rateCards.$inferSelect
type RowRow = typeof rateCardRows.$inferSelect

export type PublishRowsInput = {
  projectId: string
  cardId: string
  drafts: readonly RowDraft[]
  /** Open rows to end where the drafts start, in the same transaction (a meter regroup). */
  closeRowIds?: readonly string[]
  effectiveFrom: number
  now: number
  /** The project's features; a draft for any other slug is UNKNOWN_FEATURE. */
  features: readonly FeaturePricing[]
  /** Project features the pricing core cannot read; a draft for one is FEATURE_NOT_PRICEABLE. */
  unpriceable?: readonly UnpriceableFeature[]
}

export type PublishCostPlusInput = Omit<PublishRowsInput, "drafts" | "closeRowIds"> & {
  /** The `draftHash` of the preview the caller reviewed. */
  draftHash: string
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

export type CostPlusPreview = { draft: CostPlusDraft; draftHash: string }

/** Rate cards, their effective-dated rows, and the model cost catalog (ADR-0008 D2, D3). */
export class RateCardService {
  constructor(private readonly deps: RateCardServiceDeps) {}

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

  async listCards(projectId: string): Promise<RateCard[]> {
    const rows = await this.deps.db
      .select()
      .from(rateCards)
      .where(eq(rateCards.projectId, projectId))
      .orderBy(asc(rateCards.name))
    return rows.map(toRateCard)
  }

  /** The card and every row it ever had, oldest first per feature. */
  async getCard(
    projectId: string,
    cardId: string
  ): Promise<Result<{ card: RateCard; rows: RateRow[] }, UnPriceRateCardError>> {
    const [card] = await this.deps.db
      .select()
      .from(rateCards)
      .where(and(eq(rateCards.projectId, projectId), eq(rateCards.id, cardId)))
    if (!card) return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId }))
    return Ok({
      card: toRateCard(card),
      rows: await this.cardRows(this.deps.db, projectId, cardId),
    })
  }

  /** The rows of `cardIds` whose interval overlaps [from, to). */
  async getEffectiveRows(input: {
    projectId: string
    cardIds: readonly string[]
    from: number
    to: number
  }): Promise<RateRow[]> {
    if (input.cardIds.length === 0) return []
    const rows = await this.deps.db
      .select()
      .from(rateCardRows)
      .where(
        and(
          eq(rateCardRows.projectId, input.projectId),
          inArray(rateCardRows.rateCardId, [...input.cardIds]),
          lt(rateCardRows.effectiveFrom, input.to),
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
    return this.withLockedCard(input.projectId, input.cardId, (tx, card, rows) =>
      writePublish(tx, input, card, rows, input.drafts)
    )
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
    return this.withLockedCard(input.projectId, input.cardId, async (tx, card, rows) => {
      const preview = await costPlusPreview(tx, card, rows, input.now)
      if (preview.err) return Err(preview.err)
      const { changes } = preview.val.draft
      const drafts: RowDraft[] = changes.filter(writesRow).map((change) => {
        const { featureSlug, match, price, cost, source, sourceRef } = change.proposed
        return { featureSlug, match: { ...match }, price, cost, source, sourceRef }
      })
      const skipped = changes.length - drafts.length
      if (drafts.length === 0) return Ok({ inserted: [], closed: [], unchanged: skipped })
      if (preview.val.draftHash !== input.draftHash) {
        return Err(
          new UnPriceRateCardError({ code: "DRAFT_STALE", draftHash: preview.val.draftHash })
        )
      }
      const published = await writePublish(tx, input, card, rows, drafts)
      if (published.err) return Err(published.err)
      return Ok({ ...published.val, unchanged: published.val.unchanged + skipped })
    })
  }

  /** Ends open rows at `effectiveTo`; see `planClose` for the rules. */
  async closeRows(input: CloseRowsInput): Promise<Result<CloseRowsResult, UnPriceRateCardError>> {
    return this.withLockedCard(input.projectId, input.cardId, async (tx, _card, rows) => {
      const plan = planClose({
        rows,
        rowIds: input.rowIds,
        effectiveTo: input.effectiveTo,
        now: input.now,
      })
      if (plan.err) return Err(plan.err)
      const rowIds = plan.val.closes.map((close) => close.rowId)
      await closeOpenRows(tx, input.projectId, rowIds, input.effectiveTo)
      return Ok({ closed: [...plan.val.closes], unchanged: plan.val.unchanged })
    })
  }

  /**
   * The cost-plus revision of a card at `at`, with a hash of the rows it would write. Each proposed
   * row's `sourceRef` is the id of the cost row it was priced from. `publishCostPlus` recomputes
   * the revision at its own now, so only a preview at the current time is meant to be published.
   */
  async previewCostPlus(
    projectId: string,
    cardId: string,
    at: number
  ): Promise<Result<CostPlusPreview, UnPriceRateCardError>> {
    const found = await this.getCard(projectId, cardId)
    if (found.err) return Err(found.err)
    return costPlusPreview(this.deps.db, found.val.card, found.val.rows, at)
  }

  /** The newest `modelsdev` cost of each provider and model. */
  async latestImportedCosts(): Promise<ModelCost[]> {
    const rows = await this.deps.db
      .selectDistinctOn([modelCosts.provider, modelCosts.model])
      .from(modelCosts)
      .where(eq(modelCosts.source, "modelsdev"))
      .orderBy(asc(modelCosts.provider), asc(modelCosts.model), desc(modelCosts.effectiveFrom))
    return rows.map(toModelCost)
  }

  /** Inserts costs; a cost already stored at the same version is skipped. Returns the count. */
  async insertModelCosts(costs: readonly ModelCost[]): Promise<number> {
    if (costs.length === 0) return 0
    const inserted = await this.deps.db
      .insert(modelCosts)
      .values(
        costs.map((cost) => ({
          id: newId("model_cost"),
          provider: cost.provider,
          model: cost.model,
          components: toWire<ModelCostRow["components"]>(cost.components),
          effectiveFrom: cost.effectiveFrom,
          source: cost.source,
          sourceRef: cost.sourceRef,
        }))
      )
      .onConflictDoNothing()
      .returning({ id: modelCosts.id })
    return inserted.length
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
   * plan against the same rows.
   */
  private async withLockedCard<T>(
    projectId: string,
    cardId: string,
    write: (
      tx: Transaction,
      card: RateCard,
      rows: RateRow[]
    ) => Promise<Result<T, UnPriceRateCardError>>
  ): Promise<Result<T, UnPriceRateCardError>> {
    return this.deps.db.transaction(async (tx) => {
      const [card] = await tx
        .select()
        .from(rateCards)
        .where(and(eq(rateCards.projectId, projectId), eq(rateCards.id, cardId)))
        .for("update")
      if (!card) return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId }))
      return write(tx, toRateCard(card), await this.cardRows(tx, projectId, cardId))
    })
  }
}

async function writePublish(
  tx: Transaction,
  input: Omit<PublishRowsInput, "drafts" | "cardId">,
  card: RateCard,
  rows: readonly RateRow[],
  drafts: readonly RowDraft[]
): Promise<Result<PublishRowsResult, UnPriceRateCardError>> {
  const plan = planPublish({
    card,
    rows,
    drafts,
    closeRowIds: input.closeRowIds,
    effectiveFrom: input.effectiveFrom,
    now: input.now,
    features: input.features,
    unpriceable: input.unpriceable,
    newRowId: () => newId("rate_card_row"),
  })
  if (plan.err) return Err(plan.err)
  const closedIds = plan.val.closes.map((close) => close.rowId)
  await closeOpenRows(tx, input.projectId, closedIds, input.effectiveFrom)
  if (plan.val.inserts.length > 0) {
    await tx
      .insert(rateCardRows)
      .values(plan.val.inserts.map((row) => toInsert(input.projectId, row)))
  }
  return Ok({
    inserted: [...plan.val.inserts],
    closed: [...plan.val.closes],
    unchanged: plan.val.unchanged,
  })
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

async function costPlusPreview(
  executor: DbExecutor,
  card: RateCard,
  rows: readonly RateRow[],
  at: number
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
  // costPlusRevision copies a cost's sourceRef onto its proposed row, and a catalog row
  // references the cost row it was priced from.
  const costs = costRows.map((row) => ({ ...toModelCost(row), sourceRef: row.id }))
  const costPlusCard: CostPlusCard = { ...card, marginPolicy: card.marginPolicy }
  const draft = costPlusRevision(costPlusCard, costs, rows, at)
  return Ok({ draft, draftHash: draftHash(draft) })
}

type ModelCostRow = typeof modelCosts.$inferSelect

/** Hashes what publishing the draft would write, so a stale preview cannot be published. */
export function draftHash(draft: CostPlusDraft): string {
  return stableHash(
    draft.changes.filter(writesRow).map((change) => ({
      type: change.type,
      current: change.type === "changed" ? change.current.id : null,
      proposed: change.proposed,
    }))
  )
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

function toModelCost(row: ModelCostRow): ModelCost {
  return modelCostSchema.parse({
    provider: row.provider,
    model: row.model,
    components: row.components,
    effectiveFrom: row.effectiveFrom,
    source: row.source,
    sourceRef: row.sourceRef,
  })
}
