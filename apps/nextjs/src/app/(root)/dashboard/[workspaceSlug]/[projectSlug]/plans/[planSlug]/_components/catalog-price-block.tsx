"use client"

import { COST_COMPONENT_NAMES } from "@unprice/db/validators"
import { MODEL_CATALOG_VERSION } from "@unprice/services/budgets"
import { priceTableOf } from "@unprice/services/pricing"
import { Button } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { CreditCard } from "lucide-react"
import { useParams } from "next/navigation"
import { useState } from "react"
import {
  COMPONENT_LABEL,
  type CatalogPolicyDraft,
  type CatalogPreview,
  DEFAULT_CATALOG_POLICY,
  catalogPricingInputOf,
  describePolicyDraft,
  policyDraftOf,
} from "~/components/pricing/catalog-policy"
import type { FeaturePriceRows } from "~/components/pricing/plan-prices"
import { PriceMatrix } from "~/components/pricing/price-matrix"
import {
  catalogPolicyFor,
  describeChanges,
  markupPercent,
  matrixOf,
} from "~/components/pricing/rate-card-format"
import { CollapsibleSection } from "~/components/pricing/section-label"
import { catalogPreviewOf, useCatalogPricing } from "~/components/pricing/use-catalog-pricing"
import type { PlanVersionCard } from "~/components/pricing/use-version-pricing"
import { SuperLink } from "~/components/super-link"
import { toast } from "~/lib/toast"

/**
 * Prices a feature's models from the cost catalog on the version's own card: one markup over the
 * provider's cost, previewed, then published as one row per model.
 */
export function CatalogPriceBlock({
  planVersionId,
  featureSlug,
  currency,
  dimension,
  card,
  rows,
  editable,
  pendingSave,
  now,
}: {
  planVersionId: string
  featureSlug: string
  currency: string
  /** The meter's only dimension; absent when it has several, and the server picks. */
  dimension: string | undefined
  card: PlanVersionCard | undefined
  rows: FeaturePriceRows | undefined
  editable: boolean
  /** The dimension is typed but not saved yet: the catalog prices the saved meter. */
  pendingSave?: boolean
  now: number
}) {
  // null until edited: the saved policy, or the default for a feature not priced from the catalog.
  const [edited, setPolicy] = useState<CatalogPolicyDraft | null>(null)
  const saved = card ? catalogPolicyFor(card.card.marginPolicy, featureSlug) : null
  const policy = edited ?? (saved ? policyDraftOf(saved) : DEFAULT_CATALOG_POLICY)
  const input = catalogPricingInputOf(policy, dimension)
  const pricing = useCatalogPricing({ planVersionId, featureSlug }, input)
  const { preview, problem } = pricing

  return (
    <CatalogPriceBlockView
      featureSlug={featureSlug}
      now={now}
      card={card}
      rows={rows}
      currency={currency}
      editable={editable}
      pendingSave={pendingSave}
      policy={policy}
      onPolicyChange={(next) => {
        setPolicy(next)
        pricing.reset()
      }}
      preview={preview}
      problem={problem}
      isPreviewing={pricing.isPreviewing}
      isPublishing={pricing.isApplying}
      onPreview={() => {
        void pricing.runPreview(input)
      }}
      onPublish={() => {
        if (!input.ok) return
        void pricing.apply(input.input).then((published) => {
          if (!published) return
          toast.success(
            `Published ${published.inserted.length} model prices, ended ${published.closed.length}`
          )
          setPolicy(null)
        })
      }}
    />
  )
}

const SHOWN_MODELS = 6

/** The block itself, controlled so a test can render each state with fixed data. */
export function CatalogPriceBlockView({
  featureSlug,
  card,
  rows,
  currency,
  editable,
  pendingSave = false,
  policy,
  onPolicyChange,
  preview,
  problem,
  isPreviewing,
  isPublishing,
  onPreview,
  onPublish,
  now,
}: {
  featureSlug: string
  card: PlanVersionCard | undefined
  rows: FeaturePriceRows | undefined
  currency: string
  editable: boolean
  pendingSave?: boolean
  policy: CatalogPolicyDraft
  onPolicyChange: (policy: CatalogPolicyDraft) => void
  preview: CatalogPreview | null
  problem: string | null
  isPreviewing?: boolean
  isPublishing?: boolean
  onPreview: () => void
  onPublish: () => void
  now: number
}) {
  const params = useParams<{
    workspaceSlug: string
    projectSlug: string
    planSlug?: string
    planVersionId?: string
  }>()
  const [isMappingOpen, setIsMappingOpen] = useState(false)
  const pricesHref =
    params?.planSlug && params?.planVersionId
      ? `/${params.workspaceSlug}/${params.projectSlug}/plans/${params.planSlug}/${params.planVersionId}/prices`
      : card
        ? `/${params?.workspaceSlug}/${params?.projectSlug}/rate-cards/${card.card.id}`
        : null
  const priced = rows?.byDimension ?? []
  const table = priceTableOf(featureSlug, priced, now, currency, "unit")
  const activePolicy = card ? catalogPolicyFor(card.card.marginPolicy, featureSlug) : null
  const { changes, writes } = catalogPreviewOf(preview, featureSlug)

  if (currency !== "USD") {
    return (
      <p className="rounded-md border bg-background-bgSubtle/40 p-3 text-muted-foreground text-xs">
        Catalog pricing is in USD; price {currency} models{" "}
        {pricesHref ? (
          <SuperLink href={pricesHref} className="underline-offset-4 hover:underline">
            on the price list.
          </SuperLink>
        ) : (
          "on the price list."
        )}
      </p>
    )
  }

  return (
    <div className="space-y-3 rounded-md border bg-background-bgSubtle/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-medium text-sm">
          <CreditCard className="size-3.5 text-muted-foreground" />
          Model prices
        </span>
        {pricesHref && priced.length > 0 && (
          <SuperLink
            href={pricesHref}
            className="text-muted-foreground text-xs underline-offset-4 hover:underline"
          >
            All prices and history
          </SuperLink>
        )}
      </div>

      {priced.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs">
            <span className="tabular-nums">{table.lines.length} models priced</span>
            {activePolicy && (
              <span className="text-muted-foreground">
                {" "}
                · follows models.dev {MODEL_CATALOG_VERSION} at cost +{" "}
                {markupPercent(activePolicy.markup)}%
              </span>
            )}
          </p>
          <PriceMatrix
            matrix={matrixOf(table)}
            currency={currency}
            unit="unit"
            limit={SHOWN_MODELS}
            className="bg-background"
          />
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          Not priced yet. Pick a markup over the provider's cost and preview what every model in
          models.dev {MODEL_CATALOG_VERSION} would cost.
        </p>
      )}

      {editable && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="catalog-markup" className="text-xs">
                Markup over cost
              </Label>
              <div className="flex items-center gap-1.5">
                <Input
                  id="catalog-markup"
                  inputMode="decimal"
                  className="h-8 w-20 text-right text-xs tabular-nums"
                  value={policy.markupPercent}
                  onChange={(event) =>
                    onPolicyChange({ ...policy, markupPercent: event.target.value })
                  }
                />
                <span className="text-muted-foreground text-xs">%</span>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={onPreview}
              disabled={isPreviewing || pendingSave}
            >
              Preview prices
            </Button>
          </div>
          {pendingSave && (
            <p className="text-muted-foreground text-xs">
              Save the feature first: the catalog prices the meter as saved, and its dimension is
              not saved yet.
            </p>
          )}

          <CollapsibleSection
            label="Event properties"
            summary={describePolicyDraft(policy)}
            open={isMappingOpen}
            onOpenChange={setIsMappingOpen}
          >
            <div className="grid grid-cols-2 gap-3">
              {COST_COMPONENT_NAMES.map((component) => (
                <div key={component} className="flex flex-col gap-1.5">
                  <Label htmlFor={`catalog-${component}`} className="text-xs">
                    {COMPONENT_LABEL[component]} property
                  </Label>
                  <Input
                    id={`catalog-${component}`}
                    className="h-8 font-mono text-xs"
                    placeholder="empty to skip"
                    value={policy.components[component]}
                    onChange={(event) =>
                      onPolicyChange({
                        ...policy,
                        components: { ...policy.components, [component]: event.target.value },
                      })
                    }
                  />
                </div>
              ))}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="catalog-round-to" className="text-xs">
                  Round prices to
                </Label>
                <Input
                  id="catalog-round-to"
                  inputMode="decimal"
                  className="h-8 text-xs tabular-nums"
                  value={policy.roundTo}
                  onChange={(event) => onPolicyChange({ ...policy, roundTo: event.target.value })}
                />
              </div>
            </div>
          </CollapsibleSection>

          {preview && changes && (
            <div className="space-y-2">
              <p className="text-xs">
                {writes === 0
                  ? "Nothing to publish; the card already has these prices."
                  : `${describeChanges(changes)} at cost + ${policy.markupPercent}%.`}
              </p>
              {changes.lines.length > 0 && (
                <PriceMatrix
                  matrix={changes}
                  currency={currency}
                  unit="unit"
                  limit={8}
                  className="bg-background"
                />
              )}
              {preview.tieredModels.length > 0 && (
                <p className="text-muted-foreground text-xs">
                  Priced at their base context tier; longer contexts cost the provider more:{" "}
                  <span className="font-mono">{preview.tieredModels.join(", ")}</span>
                </p>
              )}
              {writes > 0 && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    onClick={onPublish}
                    disabled={isPublishing || !preview.draftHash}
                  >
                    Publish {writes} model {writes === 1 ? "price" : "prices"}
                  </Button>
                </div>
              )}
            </div>
          )}

          {problem && <p className="text-destructive text-xs">{problem}</p>}
        </>
      )}
    </div>
  )
}
