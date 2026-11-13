import { DomainError, type DomainErrorKind } from "../domain-error-kind"
import type { CardViolation } from "../pricing"

/** A project feature the pricing core cannot read, and the field of its meter that breaks it. */
export type UnpriceableFeature = Readonly<{ slug: string; reason: string }>

export type RateCardRejection =
  | Readonly<{ code: "CARD_NOT_FOUND"; cardId: string }>
  | Readonly<{ code: "CARD_NAME_TAKEN"; name: string }>
  | Readonly<{ code: "UNKNOWN_FEATURE"; features: readonly string[] }>
  | Readonly<{ code: "FEATURE_NOT_PRICEABLE"; features: readonly UnpriceableFeature[] }>
  | Readonly<{ code: "NOTICE_TOO_SHORT"; featureSlug: string; earliest: number }>
  | Readonly<{ code: "SCHEDULE_CONFLICT"; featureSlug: string; scheduledFrom: number }>
  | Readonly<{ code: "INVALID_CARD"; violations: readonly CardViolation[] }>
  | Readonly<{ code: "DRAFT_STALE"; draftHash: string }>
  | Readonly<{ code: "NOT_COST_PLUS"; cardId: string }>
  | Readonly<{ code: "ROW_NOT_FOUND"; rowIds: readonly string[] }>
  | Readonly<{ code: "ROW_CLOSED"; rowId: string; effectiveTo: number }>
  | Readonly<{ code: "PLAN_VERSION_NOT_FOUND"; planVersionId: string }>
  | Readonly<{ code: "PLAN_VERSION_PUBLISHED"; planVersionId: string }>
  | Readonly<{ code: "CARD_UNIT_MISMATCH"; cardId: string; unit: string; currency: string }>
  /** The version's card also prices another version, so editing it would reprice that one too. */
  | Readonly<{ code: "CARD_SHARED"; cardId: string; planVersionId: string }>
  /** The cost catalog is in USD, so only a USD version can price from it. */
  | Readonly<{ code: "CATALOG_USD_ONLY"; unit: string }>
  /** Catalog pricing needs the feature's meter dimension that carries the model id. */
  | Readonly<{ code: "DIMENSION_REQUIRED"; featureSlug: string; dimensions: readonly string[] }>
  /** The price given has the wrong form for the feature's package: a price or tiers. */
  | Readonly<{ code: "PRICE_SHAPE_MISMATCH"; featureSlug: string; expected: "price" | "tiers" }>

export type RateCardErrorCode = RateCardRejection["code"]

const KIND: Record<RateCardErrorCode, DomainErrorKind> = {
  CARD_NOT_FOUND: "not_found",
  NOT_COST_PLUS: "precondition",
  CARD_NAME_TAKEN: "conflict",
  UNKNOWN_FEATURE: "bad_request",
  FEATURE_NOT_PRICEABLE: "bad_request",
  NOTICE_TOO_SHORT: "bad_request",
  SCHEDULE_CONFLICT: "conflict",
  INVALID_CARD: "bad_request",
  DRAFT_STALE: "conflict",
  ROW_NOT_FOUND: "not_found",
  ROW_CLOSED: "conflict",
  PLAN_VERSION_NOT_FOUND: "not_found",
  PLAN_VERSION_PUBLISHED: "precondition",
  CARD_UNIT_MISMATCH: "bad_request",
  CARD_SHARED: "precondition",
  CATALOG_USD_ONLY: "precondition",
  DIMENSION_REQUIRED: "precondition",
  PRICE_SHAPE_MISMATCH: "bad_request",
}

function message(rejection: RateCardRejection): string {
  switch (rejection.code) {
    case "CARD_NOT_FOUND":
      return `Rate card ${rejection.cardId} not found`
    case "CARD_NAME_TAKEN":
      return `A rate card named ${rejection.name} already exists`
    case "UNKNOWN_FEATURE":
      return `Unknown features: ${rejection.features.join(", ")}`
    case "FEATURE_NOT_PRICEABLE":
      return `Features the pricing core cannot read: ${rejection.features
        .map((feature) => `${feature.slug} (${feature.reason})`)
        .join(", ")}`
    case "NOTICE_TOO_SHORT":
      return `A price change for ${rejection.featureSlug} can start at ${new Date(rejection.earliest).toISOString()} at the earliest`
    case "SCHEDULE_CONFLICT":
      return `${rejection.featureSlug} already has a price scheduled from ${new Date(rejection.scheduledFrom).toISOString()}; a change must start after it`
    case "INVALID_CARD":
      return `The card would be invalid: ${JSON.stringify(rejection.violations)}`
    case "DRAFT_STALE":
      return "The cost-plus draft changed since it was previewed; preview it again"
    case "NOT_COST_PLUS":
      return `Rate card ${rejection.cardId} has no cost-plus margin policy`
    case "ROW_NOT_FOUND":
      return `Rate rows not found: ${rejection.rowIds.join(", ")}`
    case "ROW_CLOSED":
      return `Rate row ${rejection.rowId} already ends at ${new Date(rejection.effectiveTo).toISOString()}`
    case "PLAN_VERSION_NOT_FOUND":
      return `Plan version ${rejection.planVersionId} not found`
    case "PLAN_VERSION_PUBLISHED":
      return `Plan version ${rejection.planVersionId} is published; its cards are part of the package`
    case "CARD_UNIT_MISMATCH":
      return `Rate card ${rejection.cardId} prices in ${rejection.unit}; a plan version invoiced in ${rejection.currency} needs money:${rejection.currency}`
    case "CARD_SHARED":
      return `Rate card ${rejection.cardId} also prices plan version ${rejection.planVersionId}; give this version its own card before changing its prices`
    case "CATALOG_USD_ONLY":
      return `The model cost catalog is in USD; a ${rejection.unit} card cannot price from it`
    case "DIMENSION_REQUIRED":
      return rejection.dimensions.length === 0
        ? `${rejection.featureSlug} needs a meter dimension that carries the model id before the catalog can price it per model`
        : `${rejection.featureSlug} varies by ${rejection.dimensions.join(", ")}; name the dimension that carries the model id`
    case "PRICE_SHAPE_MISMATCH":
      return `${rejection.featureSlug} is priced with ${rejection.expected === "tiers" ? "graduated tiers" : "one price"}, so it takes ${rejection.expected}`
  }
}

/** An expected rate card failure; `rejection` is plain data for adapters to map. */
export class UnPriceRateCardError extends DomainError<{ code: RateCardErrorCode }> {
  public readonly retry = false
  public readonly name = "UnPriceRateCardError"
  public readonly code: RateCardErrorCode
  public readonly kind: DomainErrorKind

  constructor(public readonly rejection: RateCardRejection) {
    super({ message: message(rejection), context: { code: rejection.code } })
    this.code = rejection.code
    this.kind = KIND[rejection.code]
  }
}
