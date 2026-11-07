"use client"

import { useQuery } from "@tanstack/react-query"
import type { Currency } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import { Pencil } from "lucide-react"
import { useState } from "react"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import {
  type FeatureLabel,
  RateCardDetail,
} from "../../../../rate-cards/_components/rate-card-detail"
import {
  catalogPolicyFor,
  changeMatrixOf,
  countWrites,
  describeChanges,
  markupPercent,
} from "../../../../rate-cards/_components/rate-card-format"
import {
  type CatalogPreview,
  catalogPricingInputOf,
  policyDraftOf,
  useCatalogPricing,
} from "../../_components/catalog-price-block"
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
  const trpc = useTRPC()
  const [open, setOpen] = useState(false)
  const [percent, setPercent] = useState<string | null>(null)
  const [preview, setPreview] = useState<CatalogPreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const { data } = useQuery(trpc.rateCards.forPlanVersion.queryOptions({ planVersionId }))
  const card = data?.cards.find((entry) => entry.currency === currency)
  const policy = card ? catalogPolicyFor(card.card.marginPolicy, featureSlug) : null
  const saved = policy ? markupPercent(policy.markup) : null
  const typed = percent ?? saved ?? ""

  const pricing = useCatalogPricing({ planVersionId, featureSlug })

  if (!policy || saved === null) return null

  const writes = preview ? countWrites(preview.draft) : 0
  const changes = preview ? changeMatrixOf(preview.draft, featureSlug) : null

  const policyInput = () =>
    catalogPricingInputOf({ ...policyDraftOf(policy), markupPercent: typed }, policy.dimension)

  // A dry run: nothing is saved until "Reprice", so closing the popover changes nothing.
  const runPreview = () => {
    const built = policyInput()
    if (!built.ok) return setProblem(built.message)
    setProblem(null)
    pricing.preview(built.input).then(setPreview, (error: Error) => setProblem(error.message))
  }

  const reprice = () => {
    const built = policyInput()
    if (!built.ok) return setProblem(built.message)
    if (!preview?.draftHash) return
    pricing.apply({ ...built.input, draftHash: preview.draftHash }).then(
      ({ inserted }) => {
        toast.success(
          inserted.length > 0
            ? `Repriced ${inserted.length} models at cost + ${typed}%`
            : `Markup saved at ${typed}%`
        )
        setOpen(false)
      },
      (error: Error) => setProblem(error.message)
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setPercent(null)
          setPreview(null)
          setProblem(null)
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
                  setPreview(null)
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
                  : `Model prices: ${describeChanges(changes)}.`}
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
