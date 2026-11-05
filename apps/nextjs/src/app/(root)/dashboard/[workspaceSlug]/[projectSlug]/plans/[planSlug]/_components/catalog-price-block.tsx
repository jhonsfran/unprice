"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { AMOUNT_PATTERN } from "@unprice/money"
import { MODEL_CATALOG_PROVIDERS, MODEL_CATALOG_VERSION } from "@unprice/services/budgets"
import { describeRatePrice } from "@unprice/services/pricing"
import type { RouterInputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { cn } from "@unprice/ui/utils"
import { CreditCard } from "lucide-react"
import { useParams } from "next/navigation"
import { useState } from "react"
import { SuperLink } from "~/components/super-link"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { CostPlusChanges } from "../../../rate-cards/_components/cost-plus-draft"
import {
  type CostPlusDraftWire,
  countWrites,
  formatMatch,
} from "../../../rate-cards/_components/rate-card-format"
import { type FeaturePriceRows, cardLabel } from "../../_components/plan-prices"
import type { PlanVersionCard } from "./price-block"

/** The cost components the catalog carries, each priced from one event property. */
export const COST_COMPONENTS = ["input", "output", "cache_read", "cache_write"] as const
export type CostComponent = (typeof COST_COMPONENTS)[number]

const COMPONENT_LABEL: Record<CostComponent, string> = {
  input: "Input",
  output: "Output",
  cache_read: "Cache read",
  cache_write: "Cache write",
}

/** What the operator types; `catalogPricingInputOf` turns it into the procedure's input. */
export type CatalogPolicyDraft = Readonly<{
  markupPercent: string
  roundTo: string
  components: Readonly<Record<CostComponent, string>>
}>

export const DEFAULT_CATALOG_POLICY: CatalogPolicyDraft = {
  markupPercent: "30",
  roundTo: "0.000001",
  components: {
    input: "input_tokens",
    output: "output_tokens",
    cache_read: "cache_read_tokens",
    cache_write: "cache_write_tokens",
  },
}

/** The preview `rateCards.setCatalogPricing` answers; `publishCostPlus` publishes it under `draftHash`. */
export type CatalogPreview = Readonly<{
  cardId: string
  draft: CostPlusDraftWire
  draftHash: string | null
  /** Models the catalog prices by context length; the preview prices their base tier. */
  tieredModels: readonly string[]
}>

type CatalogPricingInput = RouterInputs["rateCards"]["setCatalogPricing"]

/** "30" as the policy's markup "0.3"; null when it is not a non-negative number. */
export function markupRateOf(percent: string): string | null {
  const text = percent.trim()
  const value = Number(text)
  if (text === "" || !Number.isFinite(value) || value < 0) return null
  return (value / 100).toFixed(8).replace(/\.?0+$/, "")
}

/** The procedure's input from the typed policy, or what stops it. */
export function catalogPricingInputOf(
  draft: CatalogPolicyDraft,
  dimension: string | undefined
):
  | { ok: true; input: Omit<CatalogPricingInput, "planVersionId" | "featureSlug"> }
  | { ok: false; message: string } {
  const markup = markupRateOf(draft.markupPercent)
  if (markup === null) return { ok: false, message: "Markup is a percentage, like 30." }
  const roundTo = draft.roundTo.trim()
  if (!AMOUNT_PATTERN.test(roundTo) || Number(roundTo) <= 0) {
    return { ok: false, message: "Round to is a positive decimal, like 0.000001." }
  }
  const componentMap: Record<string, string> = {}
  for (const component of COST_COMPONENTS) {
    const property = draft.components[component].trim()
    if (property) componentMap[component] = property
  }
  if (Object.keys(componentMap).length === 0) {
    return { ok: false, message: "Map at least one cost component to an event property." }
  }
  return {
    ok: true,
    input: { markup, roundTo, componentMap, ...(dimension ? { dimension } : {}) },
  }
}

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
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [policy, setPolicy] = useState<CatalogPolicyDraft>(DEFAULT_CATALOG_POLICY)
  const [preview, setPreview] = useState<CatalogPreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const previewPrices = useMutation(
    trpc.rateCards.setCatalogPricing.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: (result: CatalogPreview) => {
        setPreview(result)
        setProblem(null)
      },
      onError: (error) => setProblem(error.message),
    })
  )
  const publishPrices = useMutation(
    trpc.rateCards.publishCostPlus.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: ({ inserted, closed }) => {
        toast.success(`Published ${inserted.length} model prices, closed ${closed.length}`)
        setPreview(null)
        void queryClient.invalidateQueries(trpc.rateCards.forPlanVersion.pathFilter())
        void queryClient.invalidateQueries({ queryKey: trpc.planVersions.getById.queryKey() })
      },
      onError: (error) => setProblem(error.message),
    })
  )

  return (
    <CatalogPriceBlockView
      card={card}
      rows={rows}
      currency={currency}
      dimension={dimension}
      editable={editable}
      pendingSave={pendingSave}
      policy={policy}
      onPolicyChange={(next) => {
        setPolicy(next)
        setPreview(null)
      }}
      preview={preview}
      problem={problem}
      isPreviewing={previewPrices.isPending}
      isPublishing={publishPrices.isPending}
      onPreview={() => {
        const built = catalogPricingInputOf(policy, dimension)
        if (!built.ok) {
          setProblem(built.message)
          return
        }
        setProblem(null)
        previewPrices.mutate({ planVersionId, featureSlug, ...built.input })
      }}
      onPublish={() => {
        if (!preview?.draftHash) return
        publishPrices.mutate({ cardId: preview.cardId, draftHash: preview.draftHash })
      }}
    />
  )
}

/** The block itself, controlled so a test can render each state with fixed data. */
export function CatalogPriceBlockView({
  card,
  rows,
  currency,
  dimension,
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
}: {
  card: PlanVersionCard | undefined
  rows: FeaturePriceRows | undefined
  currency: string
  dimension: string | undefined
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
  const label = card
    ? cardLabel(
        card.card.name,
        params?.planSlug && params?.planVersionId
          ? { planSlug: params.planSlug, planVersionId: params.planVersionId, currency }
          : null
      )
    : null
  const priced = rows?.byDimension ?? []
  const writes = preview ? countWrites(preview.draft) : 0

  if (currency !== "USD") {
    return (
      <p className="rounded-md border bg-background-bgSubtle/40 p-3 text-muted-foreground text-xs">
        Catalog pricing is in USD; price {currency} models{" "}
        {cardHref ? (
          <SuperLink href={cardHref} className="underline-offset-4 hover:underline">
            on the card.
          </SuperLink>
        ) : (
          "on the card."
        )}
      </p>
    )
  }

  return (
    <div className="space-y-3 rounded-md border bg-background-bgSubtle/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-medium text-sm">
          <CreditCard className="size-3.5 text-muted-foreground" />
          Model prices from the catalog
        </span>
        {label && cardHref && (
          <SuperLink
            href={cardHref}
            className={cn(
              "truncate text-muted-foreground text-xs underline-offset-4 hover:underline",
              !label.isOwn && "font-mono"
            )}
          >
            {label.text}
          </SuperLink>
        )}
      </div>

      {priced.length > 0 ? (
        <div className="space-y-1">
          <p className="font-mono text-xs tabular-nums">
            {priced.length} prices by {dimension ?? "dimension"}
          </p>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto">
            {priced.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 font-mono text-xs tabular-nums"
              >
                <span className="truncate text-muted-foreground">{formatMatch(row.match)}</span>
                <span>{describeRatePrice(row.price, currency)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          Not priced yet. Publishing refuses a version with an unpriced feature.
        </p>
      )}

      {editable && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="catalog-markup" className="text-xs">
                Markup (%)
              </Label>
              <Input
                id="catalog-markup"
                inputMode="decimal"
                className="h-8 font-mono text-xs tabular-nums"
                value={policy.markupPercent}
                onChange={(event) =>
                  onPolicyChange({ ...policy, markupPercent: event.target.value })
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="catalog-round-to" className="text-xs">
                Round to
              </Label>
              <Input
                id="catalog-round-to"
                inputMode="decimal"
                className="h-8 font-mono text-xs tabular-nums"
                value={policy.roundTo}
                onChange={(event) => onPolicyChange({ ...policy, roundTo: event.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {COST_COMPONENTS.map((component) => (
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
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-muted-foreground text-xs">
              models.dev {MODEL_CATALOG_VERSION} · {MODEL_CATALOG_PROVIDERS.join(", ")}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
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

          {preview && (
            <div className="space-y-2">
              <CostPlusChanges draft={preview.draft} currency={currency} />
              {preview.tieredModels.length > 0 && (
                <p className="text-muted-foreground text-xs">
                  Priced at their base context tier; longer contexts cost the provider more:{" "}
                  <span className="font-mono">{preview.tieredModels.join(", ")}</span>
                </p>
              )}
              <div className="flex items-center justify-end gap-3">
                {writes === 0 ? (
                  <span className="text-muted-foreground text-xs">
                    Nothing to publish; the card already has these prices.
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onPublish}
                    disabled={isPublishing || !preview.draftHash}
                  >
                    Publish {writes} model {writes === 1 ? "price" : "prices"}
                  </Button>
                )}
              </div>
            </div>
          )}

          {problem && <p className="text-destructive text-xs">{problem}</p>}
        </>
      )}
    </div>
  )
}
