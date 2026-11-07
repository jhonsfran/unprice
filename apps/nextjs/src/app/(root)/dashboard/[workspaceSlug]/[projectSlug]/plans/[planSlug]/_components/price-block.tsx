"use client"

import type { FeatureType } from "@unprice/db/utils"
import { type RateRow, featurePriceInputSchema } from "@unprice/db/validators"
import {
  type DecimalFeaturePrice,
  type PricingShape,
  decimalPriceOf,
  describeRatePrice,
  pricingShape,
} from "@unprice/services/pricing"
import type { RouterInputs, RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Label } from "@unprice/ui/label"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { CreditCard, Plus, X } from "lucide-react"
import { useParams } from "next/navigation"
import { InputWithAddons } from "~/components/input-addons"
import { SuperLink } from "~/components/super-link"
import { type FeaturePriceRows, cardLabel, scheduledFrom } from "../../_components/plan-prices"

export type PlanVersionCard = RouterOutputs["rateCards"]["forPlanVersion"]["cards"][number]

/** The `price` a feature update carries: absent leaves it, null unprices, a value sets it. */
export type FeaturePriceInput = NonNullable<RouterInputs["planVersionFeatures"]["update"]["price"]>

/** The row shape a plan feature's package allows (`pricingShape` owns the rule). */
export type PriceShape = PricingShape

export function priceShapeOf(featureType: FeatureType, usageMode: string | undefined): PriceShape {
  return pricingShape({ featureType, usageMode: usageMode as DecimalFeaturePrice["usageMode"] })
}

/** One editable tier; `key` identifies the row while it is edited and never reaches the server. */
export type TierDraft = Readonly<{
  key: string
  upTo: string
  unitPrice: string
  flatPrice: string
}>

/** What the block edits; the parent keeps null while the user has not touched the price. */
export type PriceDraft =
  | Readonly<{ kind: "unpriced" }>
  | Readonly<{ kind: "amount"; amount: string }>
  | Readonly<{ kind: "tiers"; tiers: readonly TierDraft[] }>

export function emptyTier(key: string): TierDraft {
  return { key, upTo: "", unitPrice: "", flatPrice: "0" }
}

/**
 * A fixed feature starts included at $0, so one Save prices it; every other shape asks for a
 * number. Tiers start as "N included, then a price": a $0 tier up to `includedUnits` (the default
 * quantity, or the included units) and an open-ended tier to price, when there are units to give.
 */
export function emptyDraft(shape: PriceShape, includedUnits = 0): PriceDraft {
  if (shape === "graduated") {
    const open = emptyTier("tier-1")
    return includedUnits > 0
      ? {
          kind: "tiers",
          tiers: [
            { key: "tier-0", upTo: String(includedUnits), unitPrice: "0", flatPrice: "0" },
            open,
          ],
        }
      : { kind: "tiers", tiers: [open] }
  }
  return { kind: "amount", amount: shape === "flat" ? "0" : "" }
}

/**
 * The draft the inputs start from: the row's decimal price when it has the shape, an empty draft
 * when the feature has no row or the row has another shape, null when the row's price cannot be
 * stated in decimal form (several components, a `per` above 1).
 */
export function prefillDraft(
  row: RateRow | null,
  shape: PriceShape,
  includedUnits = 0
): PriceDraft | null {
  // A row of another shape is not this feature's price any more: $49 a cycle is not $49 a unit.
  if (!row || row.price.type !== shape) return emptyDraft(shape, includedUnits)
  const decimal = decimalPriceOf(row.price)
  if (!decimal) return null
  if (shape === "graduated") {
    return decimal.tiers
      ? {
          kind: "tiers",
          tiers: decimal.tiers.map((tier, index) => ({
            key: `tier-${index}`,
            upTo: tier.lastUnit === null ? "" : String(tier.lastUnit),
            unitPrice: tier.unitPrice,
            flatPrice: tier.flatPrice,
          })),
        }
      : emptyDraft(shape, includedUnits)
  }
  return decimal.price === undefined ? emptyDraft(shape) : { kind: "amount", amount: decimal.price }
}

/** The draft as the update mutation takes it, or what stops it from being one. */
export function priceInputOf(
  draft: PriceDraft
): { ok: true; price: FeaturePriceInput | null } | { ok: false; message: string } {
  if (draft.kind === "unpriced") return { ok: true, price: null }
  if (draft.kind === "amount") {
    const amount = draft.amount.trim()
    if (amount === "")
      return { ok: false, message: "Enter a price, or leave the feature unpriced." }
    const parsed = featurePriceInputSchema.safeParse({ price: amount })
    return parsed.success
      ? { ok: true, price: { price: amount } }
      : { ok: false, message: "A price is a non-negative decimal, like 0.02." }
  }
  const tiers: {
    firstUnit: number
    lastUnit: number | null
    unitPrice: string
    flatPrice: string
  }[] = []
  let firstUnit = 1
  for (const [index, tier] of draft.tiers.entries()) {
    const last = index === draft.tiers.length - 1
    const lastUnit = last ? null : Number(tier.upTo.trim())
    if (lastUnit !== null && (!Number.isInteger(lastUnit) || lastUnit < firstUnit)) {
      return {
        ok: false,
        message: `Tier ${index + 1} ends at a whole number of at least ${firstUnit}.`,
      }
    }
    tiers.push({
      firstUnit,
      lastUnit,
      unitPrice: tier.unitPrice.trim(),
      flatPrice: tier.flatPrice.trim() || "0",
    })
    firstUnit = (lastUnit ?? 0) + 1
  }
  const parsed = featurePriceInputSchema.safeParse({ tiers })
  return parsed.success
    ? { ok: true, price: { tiers } }
    : {
        ok: false,
        message: "Each tier needs a unit price and a flat fee as non-negative decimals.",
      }
}

const AMOUNT_LABEL: Record<Exclude<PriceShape, "graduated">, string> = {
  flat: "Amount per cycle",
  unit: "Price per unit",
  package: "Price per package",
}

/**
 * A plan feature's price on its version's card (ADR-0008 D2), edited next to the quantities it
 * depends on. The feature stores none: Save writes the package and the price in one update.
 */
export function PriceBlockView({
  card,
  rows,
  currency,
  unit,
  shape,
  editable,
  isLoading,
  draft,
  onDraftChange,
  problem,
  includedUnits = 0,
}: {
  card: PlanVersionCard | undefined
  rows: FeaturePriceRows | undefined
  currency: string
  unit: string
  shape: PriceShape
  editable: boolean
  isLoading?: boolean
  /** null while the user has not touched the price: the inputs show the current row. */
  draft: PriceDraft | null
  onDraftChange: (draft: PriceDraft | null) => void
  /** A refusal of the last save that belongs to the price. */
  problem: string | null
  /** The units a new tiers draft gives away first: the default quantity, or the included units. */
  includedUnits?: number
}) {
  const params = useParams<{
    workspaceSlug: string
    projectSlug: string
    planSlug?: string
    planVersionId?: string
  }>()
  const cardHref = card
    ? `/${params?.workspaceSlug}/${params?.projectSlug}/rate-cards/${card.card.id}`
    : null
  // The version's own card is read on its Prices tab; a shared card on its own page.
  const pricesHref =
    params?.planSlug && params?.planVersionId
      ? `/${params.workspaceSlug}/${params.projectSlug}/plans/${params.planSlug}/${params.planVersionId}/prices`
      : null
  const label = card
    ? cardLabel(
        card.card.name,
        params?.planSlug && params?.planVersionId
          ? { planSlug: params.planSlug, planVersionId: params.planVersionId, currency }
          : null
      )
    : null
  const current = rows?.current ?? null
  const scheduled = rows?.scheduled ?? null
  const row = current ?? scheduled
  const prefill = prefillDraft(row, shape, includedUnits)
  const effective = draft ?? prefill
  // A saved price of another shape (a fixed $49 on a feature switched to metered) is replaced on save.
  const replaced = row !== null && row.price.type !== shape

  if (isLoading) return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-3 rounded-md border bg-background-bgSubtle/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-medium text-sm">
          <CreditCard className="size-3.5 text-muted-foreground" />
          Price
        </span>
        {label && cardHref && (
          <SuperLink
            href={label.isOwn ? (pricesHref ?? cardHref) : cardHref}
            className={cn(
              "truncate text-muted-foreground text-xs underline-offset-4 hover:underline",
              !label.isOwn && "font-mono"
            )}
          >
            {label.isOwn ? "Price history" : label.text}
          </SuperLink>
        )}
      </div>

      {row ? (
        <div className="flex flex-col gap-0.5 text-xs">
          {current && (
            <span>
              <span className="text-muted-foreground">Saved price: </span>
              <span className={cn("font-mono tabular-nums", replaced && "line-through")}>
                {describeRatePrice(current.price, currency, unit)}
              </span>
            </span>
          )}
          {scheduled && (
            <span className="font-mono text-muted-foreground tabular-nums">
              {describeRatePrice(scheduled.price, currency, unit)} {scheduledFrom(scheduled)}
            </span>
          )}
          {replaced && editable && (
            <span className="text-muted-foreground">
              It no longer fits how this feature is charged; saving replaces it with the price
              below.
            </span>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          {shape === "flat" && editable
            ? "Included at $0 unless you set an amount."
            : "Not priced yet. Publishing refuses a version with an unpriced feature."}
        </p>
      )}

      {editable && effective === null && cardHref && (
        <p className="text-muted-foreground text-xs">
          This price has a shape the editor cannot state.{" "}
          <SuperLink href={cardHref} className="underline-offset-4 hover:underline">
            Edit it on the card.
          </SuperLink>
        </p>
      )}

      {editable && effective?.kind === "unpriced" && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">Unpriced on save.</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onDraftChange(emptyDraft(shape, includedUnits))}
          >
            Set a price
          </Button>
        </div>
      )}

      {editable && effective && effective.kind !== "unpriced" && (
        <div className="space-y-2">
          {effective.kind === "amount" && shape !== "graduated" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="feature-price" className="text-xs">
                {AMOUNT_LABEL[shape]}
              </Label>
              <InputWithAddons
                id="feature-price"
                inputMode="decimal"
                className="font-mono text-xs tabular-nums"
                leading={currency}
                trailing={shape === "flat" ? "cycle" : shape === "package" ? "package" : unit}
                placeholder="0.02"
                value={effective.amount}
                onChange={(event) => onDraftChange({ kind: "amount", amount: event.target.value })}
              />
            </div>
          ) : effective.kind === "tiers" ? (
            <TiersEditor
              tiers={effective.tiers}
              currency={currency}
              unit={unit}
              onChange={(tiers) => onDraftChange({ kind: "tiers", tiers })}
            />
          ) : null}
          {(row || draft) && (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-muted-foreground text-xs"
                onClick={() => onDraftChange({ kind: "unpriced" })}
              >
                Leave unpriced
              </Button>
            </div>
          )}
        </div>
      )}

      {problem && (
        <p className="text-destructive text-xs">
          {problem}
          {cardHref && (
            <>
              {" "}
              <SuperLink href={cardHref} className="underline-offset-4 hover:underline">
                Open the card.
              </SuperLink>
            </>
          )}
        </p>
      )}
    </div>
  )
}

function title(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Graduated tiers: each row ends at "up to" units; the last row is open-ended. */
export function TiersEditor({
  tiers,
  currency,
  unit,
  onChange,
}: {
  tiers: readonly TierDraft[]
  currency: string
  unit: string
  onChange: (tiers: readonly TierDraft[]) => void
}) {
  const update = (index: number, patch: Partial<TierDraft>) =>
    onChange(tiers.map((tier, at) => (at === index ? { ...tier, ...patch } : tier)))
  let firstUnit = 1

  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-xs">
        Each tier prices only the {unit}s inside it. Add a tier to charge differently past a
        threshold.
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_28px] gap-2 text-muted-foreground text-xs">
        <span>{title(unit)}s</span>
        <span>Price per {unit}</span>
        <span>Plus a flat fee</span>
        <span />
      </div>
      {tiers.map((tier, index) => {
        const last = index === tiers.length - 1
        const from = firstUnit
        firstUnit = (Number(tier.upTo) || 0) + 1
        return (
          <div
            key={tier.key}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_28px] items-center gap-2"
          >
            {last ? (
              <span className="flex h-9 items-center rounded-md border border-dashed px-3 font-mono text-muted-foreground text-xs tabular-nums">
                {from} and above
              </span>
            ) : (
              <InputWithAddons
                inputMode="numeric"
                aria-label={`Tier ${index + 1} ends at`}
                className="font-mono text-xs tabular-nums"
                leading={`${from} to`}
                value={tier.upTo}
                onChange={(event) => update(index, { upTo: event.target.value })}
              />
            )}
            <InputWithAddons
              inputMode="decimal"
              aria-label={`Tier ${index + 1} unit price`}
              className="font-mono text-xs tabular-nums"
              leading={currency}
              placeholder="0.02"
              value={tier.unitPrice}
              onChange={(event) => update(index, { unitPrice: event.target.value })}
            />
            <InputWithAddons
              inputMode="decimal"
              aria-label={`Tier ${index + 1} flat fee`}
              className="font-mono text-xs tabular-nums"
              leading={currency}
              value={tier.flatPrice}
              onChange={(event) => update(index, { flatPrice: event.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={tiers.length === 1}
              onClick={() => onChange(tiers.filter((_, at) => at !== index))}
            >
              <X className="size-3.5" />
              <span className="sr-only">Remove tier {index + 1}</span>
            </Button>
          </div>
        )
      })}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() =>
          onChange([...tiers.slice(0, -1), emptyTier(`tier-${Date.now()}`), ...tiers.slice(-1)])
        }
      >
        <Plus className="mr-1 size-3" />
        Add tier
      </Button>
    </div>
  )
}
