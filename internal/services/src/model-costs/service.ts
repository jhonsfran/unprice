import { and, asc, desc, eq, lte } from "@unprice/db"
import { customModelCosts, modelCosts } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import {
  type CustomModelCost,
  type ModelCost,
  type customModelCostInputSchema,
  customModelCostSchema,
  modelCostSchema,
} from "@unprice/db/validators"
import type { z } from "zod"
import { MODEL_CATALOG, MODEL_CATALOG_VERSION } from "../budgets/model-catalog"
import type { DbExecutor } from "../deps"
import { catalogCosts, changedCosts } from "../rate-cards/model-costs"
import { toWire } from "../rate-cards/wire"

/** The bundled catalog's version date as an effective instant. */
export function catalogEffectiveFrom(version: string = MODEL_CATALOG_VERSION): number {
  return Date.parse(`${version}T00:00:00.000Z`)
}

/** The bundled catalog is also available without inserting global cost rows. */
export const BUNDLED_COSTS = catalogCosts(
  MODEL_CATALOG,
  MODEL_CATALOG_VERSION,
  catalogEffectiveFrom()
)

/** Global imported costs and each project's custom model costs. */
export class ModelCostService {
  constructor(private readonly deps: { db: DbExecutor }) {}

  /** Imports changed bundled costs; the unique index makes concurrent imports idempotent. */
  async importBundled(effectiveFrom: number): Promise<{ inserted: number; unchanged: number }> {
    const proposed = catalogCosts(MODEL_CATALOG, MODEL_CATALOG_VERSION, effectiveFrom)
    const changed = changedCosts(await this.latestImportedCosts(), proposed)
    const inserted = await this.insertModelCosts(changed)
    return { inserted, unchanged: proposed.length - inserted }
  }

  async costsAt(projectId: string, at: number): Promise<ModelCost[]> {
    const costRows = await this.deps.db
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
    const customRows = await this.deps.db
      .select()
      .from(customModelCosts)
      .where(
        and(eq(customModelCosts.projectId, projectId), lte(customModelCosts.effectiveFrom, at))
      )
      .orderBy(
        asc(customModelCosts.provider),
        asc(customModelCosts.model),
        asc(customModelCosts.effectiveFrom),
        asc(customModelCosts.id)
      )
    // Bundled costs reference their catalog version; stored costs reference their row id.
    // Put the bundle first so importing the same version cannot change a preview hash.
    return [
      ...BUNDLED_COSTS.filter((cost) => cost.effectiveFrom <= at),
      ...costRows.map((row) => ({ ...toModelCost(row), sourceRef: row.id })),
      ...customRows.map((row) => customAsModelCost(toCustomModelCost(row))),
    ]
  }

  /** The newest `modelsdev` cost of each provider and model. */
  private async latestImportedCosts(): Promise<ModelCost[]> {
    const rows = await this.deps.db
      .selectDistinctOn([modelCosts.provider, modelCosts.model])
      .from(modelCosts)
      .where(eq(modelCosts.source, "modelsdev"))
      .orderBy(asc(modelCosts.provider), asc(modelCosts.model), desc(modelCosts.effectiveFrom))
    return rows.map(toModelCost)
  }

  /**
   * Adds a project's own cost for a model. Rows are never updated: an edit is a newer row, and the
   * cost-plus revision prices each model from its latest one at or before its own instant.
   */
  async addCustom(
    projectId: string,
    cost: z.infer<typeof customModelCostInputSchema>,
    now: number
  ): Promise<CustomModelCost> {
    const [row] = await this.deps.db
      .insert(customModelCosts)
      .values({
        id: newId("custom_model_cost"),
        projectId,
        provider: cost.provider,
        model: cost.model,
        components: toWire<CustomModelCostRow["components"]>(cost.components),
        effectiveFrom: now,
      })
      .returning()
    if (!row) throw new Error("custom model cost insert returned no row")
    return toCustomModelCost(row)
  }

  /** The newest custom cost of each provider and model in a project. */
  async listCustom(projectId: string): Promise<CustomModelCost[]> {
    const rows = await this.deps.db
      .selectDistinctOn([customModelCosts.provider, customModelCosts.model])
      .from(customModelCosts)
      .where(eq(customModelCosts.projectId, projectId))
      .orderBy(
        asc(customModelCosts.provider),
        asc(customModelCosts.model),
        desc(customModelCosts.effectiveFrom),
        desc(customModelCosts.id)
      )
    return rows.map(toCustomModelCost)
  }

  /** Inserts costs; a cost already stored at the same version is skipped. Returns the count. */
  private async insertModelCosts(costs: readonly ModelCost[]): Promise<number> {
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
}

type ModelCostRow = typeof modelCosts.$inferSelect
type CustomModelCostRow = typeof customModelCosts.$inferSelect

function toCustomModelCost(row: CustomModelCostRow): CustomModelCost {
  return customModelCostSchema.parse({
    id: row.id,
    provider: row.provider,
    model: row.model,
    components: row.components,
    effectiveFrom: row.effectiveFrom,
  })
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
