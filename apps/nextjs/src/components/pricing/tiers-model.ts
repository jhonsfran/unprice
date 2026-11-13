import { featurePriceInputSchema } from "@unprice/db/validators"
import { tierRanges } from "@unprice/services/pricing"
import type { DecimalFeaturePrice } from "@unprice/services/pricing"

/** One editable tier; `key` identifies the row while it is edited and never reaches the server. */
export type TierDraft = Readonly<{
  key: string
  upTo: string
  rate: string
  flat: string
}>

export function emptyTier(key: string): TierDraft {
  return { key, upTo: "", rate: "", flat: "0" }
}

/** Validate the editor's bounds and decimals without a text serialization step. */
export function tiersOf(
  drafts: readonly TierDraft[]
): { ok: true; tiers: NonNullable<DecimalFeaturePrice["tiers"]> } | { ok: false; message: string } {
  const tiers = drafts.map((tier, index) => ({
    upTo: index === drafts.length - 1 ? null : Number(tier.upTo.trim()),
    rate: tier.rate.trim(),
    flat: tier.flat.trim() || "0",
  }))
  for (const [index, tier] of tierRanges(tiers).entries()) {
    if (tier.upTo !== null && (!Number.isSafeInteger(tier.upTo) || tier.upTo < tier.from)) {
      return {
        ok: false,
        message: `Tier ${index + 1} ends at a whole number of at least ${tier.from}.`,
      }
    }
  }
  const parsed = featurePriceInputSchema.safeParse({ tiers })
  return parsed.success && parsed.data.tiers
    ? { ok: true, tiers: parsed.data.tiers }
    : {
        ok: false,
        message: "Each tier needs a unit price and a flat fee as non-negative decimals.",
      }
}
