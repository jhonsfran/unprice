import { relations, sql } from "drizzle-orm"
import {
  bigint,
  foreignKey,
  index,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { pgTableProject } from "../utils/_table"
import { cuid } from "../utils/fields"
import { projectID } from "../utils/sql"
import type { ModelCostInput, RateCardInput, RateRowInput } from "../validators/rate-cards"
import { currencyEnum } from "./enums"
import { versions } from "./planVersions"
import { projects } from "./projects"

/**
 * A rate card (ADR-0008 D2). Decimals are stored as their wire strings and parsed with the
 * `@unprice/db/validators` rate card schemas on read.
 */
export const rateCards = pgTableProject(
  "rate_cards",
  {
    ...projectID,
    name: text("name").notNull(),
    unit: text("unit").notNull(),
    creditValueUsd: text("credit_value_usd"),
    marginPolicy: jsonb("margin_policy").$type<RateCardInput["marginPolicy"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    primary: primaryKey({ columns: [table.id, table.projectId], name: "rate_cards_pkey" }),
    projectNameIdx: uniqueIndex("rate_cards_project_name_idx").on(table.projectId, table.name),
  })
)

/**
 * A card's price rows. A row is immutable: the only update ever made is setting `effective_to`
 * once, from null, when a successor is published.
 */
export const rateCardRows = pgTableProject(
  "rate_card_rows",
  {
    ...projectID,
    rateCardId: cuid("rate_card_id").notNull(),
    featureSlug: text("feature_slug").notNull(),
    match: jsonb("match").$type<RateRowInput["match"]>().notNull(),
    price: jsonb("price").$type<RateRowInput["price"]>().notNull(),
    cost: jsonb("cost").$type<NonNullable<RateRowInput["cost"]>>(),
    effectiveFrom: bigint("effective_from", { mode: "number" }).notNull(),
    effectiveTo: bigint("effective_to", { mode: "number" }),
    source: text("source").$type<RateRowInput["source"]>().notNull(),
    sourceRef: text("source_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    primary: primaryKey({ columns: [table.id, table.projectId], name: "rate_card_rows_pkey" }),
    cardFeatureFromIdx: index("rate_card_rows_card_feature_from_idx").on(
      table.rateCardId,
      table.featureSlug,
      table.effectiveFrom
    ),
    cardfk: foreignKey({
      columns: [table.rateCardId, table.projectId],
      foreignColumns: [rateCards.id, rateCards.projectId],
      name: "rate_card_rows_rate_card_id_fkey",
    }).onDelete("cascade"),
  })
)

/**
 * The rate card a plan version prices with in one currency (ADR-0008 D2): one card per currency.
 * A subscription in that currency compiles its payer budget from this card. The card's unit is the
 * budget's unit: `money:<currency>`, or `credits:<id>` for a plan sold in credits.
 */
export const planVersionRateCards = pgTableProject(
  "plan_version_rate_cards",
  {
    ...projectID,
    planVersionId: cuid("plan_version_id").notNull(),
    currency: currencyEnum("currency").notNull(),
    rateCardId: cuid("rate_card_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "plan_version_rate_cards_pkey",
    }),
    versionCurrencyIdx: uniqueIndex("plan_version_rate_cards_version_currency_idx").on(
      table.projectId,
      table.planVersionId,
      table.currency
    ),
    versionfk: foreignKey({
      columns: [table.planVersionId, table.projectId],
      foreignColumns: [versions.id, versions.projectId],
      name: "plan_version_rate_cards_plan_version_id_fkey",
    }).onDelete("cascade"),
    cardfk: foreignKey({
      columns: [table.rateCardId, table.projectId],
      foreignColumns: [rateCards.id, rateCards.projectId],
      name: "plan_version_rate_cards_rate_card_id_fkey",
    }),
  })
)

/** Provider costs per model, USD per million of each component. Global, not project-owned. */
export const modelCosts = pgTableProject(
  "model_costs",
  {
    id: cuid("id").primaryKey().notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    components: jsonb("components").$type<ModelCostInput["components"]>().notNull(),
    effectiveFrom: bigint("effective_from", { mode: "number" }).notNull(),
    source: text("source").$type<ModelCostInput["source"]>().notNull(),
    sourceRef: text("source_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    versionIdx: uniqueIndex("model_costs_version_idx").on(
      table.provider,
      table.model,
      table.source,
      table.effectiveFrom
    ),
  })
)

export const rateCardsRelations = relations(rateCards, ({ one, many }) => ({
  project: one(projects, { fields: [rateCards.projectId], references: [projects.id] }),
  rows: many(rateCardRows),
}))

export const rateCardRowsRelations = relations(rateCardRows, ({ one }) => ({
  card: one(rateCards, {
    fields: [rateCardRows.rateCardId, rateCardRows.projectId],
    references: [rateCards.id, rateCards.projectId],
  }),
}))

export const planVersionRateCardsRelations = relations(planVersionRateCards, ({ one }) => ({
  card: one(rateCards, {
    fields: [planVersionRateCards.rateCardId, planVersionRateCards.projectId],
    references: [rateCards.id, rateCards.projectId],
  }),
}))
