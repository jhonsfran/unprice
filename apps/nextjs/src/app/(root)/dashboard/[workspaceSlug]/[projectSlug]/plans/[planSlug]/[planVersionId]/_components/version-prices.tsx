"use client"

import type { Currency } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import { Pencil } from "lucide-react"
import { useState } from "react"
import { catalogPricingInputOf, policyDraftOf } from "~/components/pricing/catalog-policy"
import { catalogPolicyFor, markupPercent } from "~/components/pricing/rate-card-format"
import { useCatalogPricing } from "~/components/pricing/use-catalog-pricing"
import { useVersionPricing } from "~/components/pricing/use-version-pricing"
import { toast } from "~/lib/toast"
import {
  type FeatureLabel,
  RateCardDetail,
} from "../../../../rate-cards/_components/rate-card-detail"
import { CustomModelDialog } from "./custom-model-dialog"

/**
 * A version's price sheet, with the catalog rule's markup editable where it is read: the
 * percentage in "provider cost plus 20%" opens a small popover that previews and applies a new one.
 */
export function VersionPrices({
  cardId,
  planVersionId,
  currency,
  features,
}: {
  cardId: string
  planVersionId: string
  currency: Currency
  features: readonly FeatureLabel[]
}) {
  return (
    <RateCardDetail
      cardId={cardId}
      features={features}
      catalogMarkup={(featureSlug) => (
        <MarkupPopover
          planVersionId={planVersionId}
          currency={currency}
          featureSlug={featureSlug}
        />
      )}
      catalogActions={(featureSlug) => (
        <CustomModelDialog
          planVersionId={planVersionId}
          currency={currency}
          featureSlug={featureSlug}
        />
      )}
    />
  )
}

function MarkupPopover({
  planVersionId,
  currency,
  featureSlug,
}: {
  planVersionId: string
  currency: Currency
  featureSlug: string
}) {
  const [open, setOpen] = useState(false)
  const [percent, setPercent] = useState<string | null>(null)

  const { card } = useVersionPricing(planVersionId, currency)
  const policy = card ? catalogPolicyFor(card.card.marginPolicy, featureSlug) : null
  const saved = policy ? markupPercent(policy.markup) : null
  const typed = percent ?? saved ?? ""

  const input = policy
    ? catalogPricingInputOf({ ...policyDraftOf(policy), markupPercent: typed }, policy.dimension)
    : undefined
  const pricing = useCatalogPricing({ planVersionId, featureSlug }, input)
  const { preview, problem, writes, changes, summary } = pricing
  if (!policy || saved === null) return null

  const runPreview = () => {
    if (input) void pricing.runPreview(input)
  }
  const reprice = () => {
    if (!input?.ok) return
    void pricing.apply(input.input).then((published) => {
      if (!published) return
      toast.success(
        published.inserted.length > 0
          ? `Repriced ${published.inserted.length} models at cost + ${typed}%`
          : `Markup saved at ${typed}%`
      )
      setOpen(false)
    })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setPercent(null)
          pricing.reset()
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-sm px-1 font-medium text-foreground underline decoration-dotted underline-offset-4 hover:bg-background-bgHover"
          aria-label={`Markup ${saved}%, change it`}
        >
          {saved}%
          <Pencil className="size-3 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72" align="start">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            runPreview()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="markup-percent" className="text-xs">
              Markup over provider cost
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="markup-percent"
                inputMode="decimal"
                className="h-8 w-20 text-right tabular-nums"
                value={typed}
                onChange={(event) => {
                  setPercent(event.target.value)
                  pricing.reset()
                }}
              />
              <span className="text-muted-foreground text-sm">%</span>
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className="ml-auto h-8"
                disabled={pricing.isPreviewing || typed === saved}
              >
                Preview
              </Button>
            </div>
          </div>
          {preview && changes && (
            <div className="flex flex-col gap-2 border-t pt-3 text-xs">
              <p>
                {writes === 0
                  ? "The prices already match this markup."
                  : `Model prices: ${summary}.`}
              </p>
              {writes > 0 && preview.draftHash ? (
                <Button type="button" size="sm" disabled={pricing.isApplying} onClick={reprice}>
                  Reprice {writes} {writes === 1 ? "model" : "models"}
                </Button>
              ) : (
                // The saved markup can drift from the prices; saving it writes no price.
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pricing.isApplying || !preview.draftHash}
                  onClick={reprice}
                >
                  Save {typed}% as the markup
                </Button>
              )}
            </div>
          )}
          {problem && <p className="text-destructive text-xs">{problem}</p>}
        </form>
      </PopoverContent>
    </Popover>
  )
}
