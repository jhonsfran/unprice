"use client"

import { type FeatureType, USAGE_MODES, USAGE_MODES_MAP } from "@unprice/db/utils"
import type { Feature, PlanVersion, PlanVersionFeatureInsert } from "@unprice/db/validators"
import { type DecimalFeaturePrice, pricingShape, singularUnit } from "@unprice/services/pricing"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { HelpCircle } from "@unprice/ui/icons"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"
import type { UseFormReturn } from "react-hook-form"
import type { FeaturePriceRows } from "~/components/pricing/plan-prices"
import type { PlanVersionCard } from "~/components/pricing/use-version-pricing"
import type { CreatedFeature } from "../../_components/feature-form"
import { CatalogPriceBlock } from "./catalog-price-block"
import {
  IncludedFormField,
  LimitFormField,
  QuantityFormField,
  ResetConfigFeatureFormField,
  UnitsFormField,
} from "./fields-form"
import { MeterSection } from "./meter-section"
import { PriceBlockView, type PriceDraft } from "./price-block"

// Plain-English overrides for the usageMode picker. Falls back to USAGE_MODES_MAP[m].label.
const USAGE_MODE_FRIENDLY_LABEL: Record<string, string> = {
  unit: "Per unit",
  tier: "Tiered",
  package: "Per bundle",
}

// ─── contextual configure fields per pricing model ───────────────────────
// Prices live on the plan version's rate card (ADR-0008 D2): each model edits the card's row next
// to what the package owns (quantities, limits, the meter, included units), and one Save writes both.
export function ConfigureFields({
  form,
  planVersion,
  featureSlug,
  unitOfMeasure,
  isDisabled,
  featureType,
  usageMode,
  feature,
  onFeatureUpdated,
  card,
  priceRows,
  isPricingLoading,
  pricingNow,
  priceDraft,
  onPriceDraftChange,
  priceProblem,
  savedDimensions,
  includedUnits,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert, unknown, PlanVersionFeatureInsert>
  planVersion: PlanVersion
  featureSlug: string
  unitOfMeasure: string
  isDisabled?: boolean
  featureType: FeatureType | undefined
  usageMode: DecimalFeaturePrice["usageMode"]
  /** The catalog feature, whose meter template the version follows unless customized. */
  feature: Feature | undefined
  onFeatureUpdated?: (feature: CreatedFeature) => void
  card: PlanVersionCard | undefined
  priceRows: FeaturePriceRows | undefined
  isPricingLoading: boolean
  pricingNow: number
  priceDraft: PriceDraft | null
  onPriceDraftChange: (draft: PriceDraft | null) => void
  priceProblem: string | null
  /** The meter's dimensions as stored; the catalog prices those, not unsaved chips. */
  savedDimensions: readonly string[]
  /** The units a new tiers draft gives away at $0. */
  includedUnits: number
}) {
  if (!featureType) {
    return (
      <p className="text-muted-foreground text-sm italic">Pick a pricing model above to start.</p>
    )
  }

  const dimensions: string[] = form.watch("meterConfig.groupBy") ?? []
  const savedDimensionSet = new Set(savedDimensions)
  const hasDimensions = featureType === "usage" && dimensions.length > 0
  const price = hasDimensions ? (
    <CatalogPriceBlock
      planVersionId={planVersion.id}
      featureSlug={featureSlug}
      currency={planVersion.currency}
      now={pricingNow}
      dimension={dimensions.length === 1 ? dimensions[0] : undefined}
      card={card}
      rows={priceRows}
      editable={!isDisabled}
      pendingSave={!dimensions.every((dimension) => savedDimensionSet.has(dimension))}
    />
  ) : (
    <PriceBlockView
      card={card}
      rows={priceRows}
      currency={planVersion.currency}
      unit={singularUnit(unitOfMeasure)}
      shape={pricingShape({ featureType, usageMode })}
      editable={!isDisabled}
      isLoading={isPricingLoading}
      draft={priceDraft}
      onDraftChange={onPriceDraftChange}
      problem={priceProblem}
      includedUnits={includedUnits}
    />
  )

  if (featureType === "flat") return price

  if (featureType === "package") {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <UnitsFormField form={form} isDisabled={isDisabled} />
          <QuantityFormField form={form} isDisabled={isDisabled} />
        </div>
        {price}
      </div>
    )
  }

  if (featureType === "tier") {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <QuantityFormField form={form} isDisabled={isDisabled} />
          <LimitFormField form={form} isDisabled={isDisabled} units={unitOfMeasure} />
        </div>
        {price}
      </div>
    )
  }

  // usage
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ModeSelect
          form={form}
          name="config.usageMode"
          label="Charge customers"
          tooltip="How consumed usage maps to a price. Set the price below."
          isDisabled={isDisabled}
          options={USAGE_MODES.filter((m) => !hasDimensions || m === "unit").map((m) => ({
            value: m,
            label: USAGE_MODE_FRIENDLY_LABEL[m] ?? USAGE_MODES_MAP[m].label,
            description: USAGE_MODES_MAP[m].description,
          }))}
          note={
            hasDimensions
              ? `Per unit only while the price varies by ${dimensions.join(", ")}.`
              : undefined
          }
        />
        {usageMode === "package" && <UnitsFormField form={form} isDisabled={isDisabled} />}
      </div>

      <MeterSection
        form={form}
        feature={feature}
        isDisabled={isDisabled}
        onFeatureUpdated={onFeatureUpdated}
      />

      {/* The reset cadence sits with the limit it refreshes, not under Advanced. */}
      <div
        className={cn(
          "grid grid-cols-1 gap-4",
          hasDimensions ? "md:grid-cols-2" : "md:grid-cols-3"
        )}
      >
        <LimitFormField form={form} isDisabled={isDisabled} units={unitOfMeasure} />
        {/* Included units and dimension rows are exclusive (ADR-0008 D5). */}
        {!hasDimensions && (
          <IncludedFormField form={form} isDisabled={isDisabled} units={unitOfMeasure} />
        )}
        <ResetConfigFeatureFormField form={form} isDisabled={isDisabled} />
      </div>

      {price}
    </div>
  )
}

// ─── small inline mode select used for usageMode ──────────────
function ModeSelect({
  form,
  name,
  label,
  tooltip,
  options,
  isDisabled,
  note,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert, unknown, PlanVersionFeatureInsert>
  name: "config.usageMode"
  label: string
  tooltip?: string
  options: Array<{ value: string; label: string; description?: string }>
  isDisabled?: boolean
  /** Why the options are what they are, when the package restricts them. */
  note?: string
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem className="space-y-1">
          <div className="flex items-center gap-1.5">
            <FormLabel className="text-xs">{label}</FormLabel>
            {tooltip && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[260px]">
                  {tooltip}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <Select onValueChange={field.onChange} value={field.value ?? ""} disabled={isDisabled}>
            <FormControl>
              <SelectTrigger className="h-8" disabled={isDisabled}>
                <SelectValue placeholder="Select" />
              </SelectTrigger>
            </FormControl>
            <SelectContent className="text-xs">
              {options.map((opt) => (
                <SelectItem value={opt.value} key={opt.value} description={opt.description}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {note && <p className="text-muted-foreground text-xs">{note}</p>}
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
