import { type Database, and, asc, desc, eq, gt, inArray, isNull, lt, lte, or } from "@unprice/db"
import { modelCosts, rateCardRows, rateCards } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import {
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
import { type CostPlusCard, type CostPlusDraft, costPlusRevision } from "../pricing"
import { UnPriceRateCardError } from "./errors"
import { type RowDraft, planPublish } from "./publish"
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
  effectiveFrom: number
  now: number
  /** The project's features; a draft for any other slug is UNKNOWN_FEATURE. */
  features: readonly FeaturePricing[]
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

  /**
   * Publishes drafts in one transaction that holds the card's row lock, so two publishes on a
   * card never plan against the same open rows. See `planPublish` for the rules.
   */
  async publishRows(
    input: PublishRowsInput
  ): Promise<Result<PublishRowsResult, UnPriceRateCardError>> {
    const { projectId, cardId } = input
    return this.deps.db.transaction(async (tx) => {
      const [card] = await tx
        .select()
        .from(rateCards)
        .where(and(eq(rateCards.projectId, projectId), eq(rateCards.id, cardId)))
        .for("update")
      if (!card) return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId }))

      const plan = planPublish({
        card: toRateCard(card),
        rows: await this.cardRows(tx, projectId, cardId),
        drafts: input.drafts,
        effectiveFrom: input.effectiveFrom,
        now: input.now,
        features: input.features,
        newRowId: () => newId("rate_card_row"),
      })
      if (plan.err) return Err(plan.err)

      for (const close of plan.val.closes) {
        const closed = await tx
          .update(rateCardRows)
          .set({ effectiveTo: close.effectiveTo })
          .where(
            and(
              eq(rateCardRows.projectId, projectId),
              eq(rateCardRows.id, close.rowId),
              isNull(rateCardRows.effectiveTo)
            )
          )
          .returning({ id: rateCardRows.id })
        if (closed.length !== 1) throw new Error(`rate row ${close.rowId} is no longer open`)
      }
      if (plan.val.inserts.length > 0) {
        await tx
          .insert(rateCardRows)
          .values(plan.val.inserts.map((row) => toInsert(projectId, row)))
      }
      return Ok({
        inserted: [...plan.val.inserts],
        closed: [...plan.val.closes],
        unchanged: plan.val.unchanged,
      })
    })
  }

  /**
   * The cost-plus revision of a card at `at`, with a hash of its changes. Each proposed row's
   * `sourceRef` is the id of the cost row it was priced from.
   */
  async previewCostPlus(
    projectId: string,
    cardId: string,
    at: number
  ): Promise<Result<CostPlusPreview, UnPriceRateCardError>> {
    const found = await this.getCard(projectId, cardId)
    if (found.err) return Err(found.err)
    const { card, rows } = found.val
    if (card.marginPolicy.type !== "costPlus") {
      return Err(new UnPriceRateCardError({ code: "NOT_COST_PLUS", cardId }))
    }
    const costRows = await this.deps.db
      .select()
      .from(modelCosts)
      .where(lte(modelCosts.effectiveFrom, at))
    // costPlusRevision copies a cost's sourceRef onto its proposed row, and a catalog row
    // references the cost row it was priced from.
    const costs = costRows.map((row) => ({ ...toModelCost(row), sourceRef: row.id }))
    const costPlusCard: CostPlusCard = { ...card, marginPolicy: card.marginPolicy }
    const draft = costPlusRevision(costPlusCard, costs, rows, at)
    return Ok({ draft, draftHash: draftHash(draft) })
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
    executor: Pick<Database, "select">,
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
}

type ModelCostRow = typeof modelCosts.$inferSelect

/** Hashes what publishing the draft would write, so a stale preview cannot be published. */
export function draftHash(draft: CostPlusDraft): string {
  return stableHash(
    draft.changes.flatMap((change) =>
      change.type === "unchanged"
        ? []
        : [
            {
              type: change.type,
              current: change.type === "changed" ? change.current.id : null,
              proposed: change.proposed,
            },
          ]
    )
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
