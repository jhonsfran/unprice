"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Info, Lock, Settings } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState } from "react"

import { DOCS_DOMAIN } from "@unprice/config"
import { OVERAGE_STRATEGIES_MAP, USAGE_MODES, USAGE_MODES_MAP } from "@unprice/db/utils"
import type { FeatureType } from "@unprice/db/utils"
import type {
  Feature,
  PlanVersion,
  PlanVersionFeature,
  PlanVersionFeatureDragDrop,
  PlanVersionFeatureInsert,
} from "@unprice/db/validators"
import {
  isResetCadenceAtMostBilling,
  planVersionFeatureInsertBaseSchema,
} from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { HelpCircle } from "@unprice/ui/icons"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Switch } from "@unprice/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"

import { SubmitButton } from "~/components/submit-button"
import { SuperLink } from "~/components/super-link"
import { useActiveFeature, useIsOnboarding, usePlanFeaturesList } from "~/hooks/use-features"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

import { FeatureDialog } from "../../_components/feature-dialog"
import type { CreatedFeature } from "../../_components/feature-form"
import {
  type FeaturePriceRows,
  priceStateOf,
  rowsByFeature,
  withDefaultRow,
} from "../../_components/plan-prices"
import { CatalogPriceBlock } from "./catalog-price-block"
import {
  BillingConfigFeatureFormField,
  IncludedFormField,
  LimitFormField,
  OverageStrategyFormField,
  QuantityFormField,
  ResetConfigFeatureFormField,
  UnitsFormField,
} from "./fields-form"
import { MeterSection } from "./meter-section"
import {
  type PlanVersionCard,
  PriceBlockView,
  type PriceDraft,
  emptyDraft,
  priceInputOf,
  priceShapeOf,
} from "./price-block"
import { PricingModelPicker, getConfigureSubtitle } from "./pricing-model"
import { CollapsibleSection, NumberedStep } from "./section-label"

// Plain-English overrides for the usageMode picker. Falls back to USAGE_MODES_MAP[m].label.
const USAGE_MODE_FRIENDLY_LABEL: Record<string, string> = {
  unit: "Per unit",
  tier: "Tiered",
  package: "Per bundle",
}

export function FeatureConfigForm({
  setDialogOpen,
  defaultValues,
  planVersion,
  planFeatures,
  className,
}: {
  defaultValues: PlanVersionFeatureInsert | PlanVersionFeature | PlanVersionFeatureDragDrop
  planVersion: PlanVersion | null
  // When provided (e.g. the customer entitlement sheet), the form runs standalone and does
  // NOT mutate the shared plan-editor atoms. Left undefined on the plans page, where the atoms
  // remain the source of truth for the inline editor's feature list.
  planFeatures?: PlanVersionFeatureDragDrop[]
  setDialogOpen?: (open: boolean) => void
  className?: string
}) {
  const router = useRouter()
  const [, setPlanFeatureList] = usePlanFeaturesList()
  const [isOnboarding] = useIsOnboarding()
  const [activeFeature, setActiveFeature] = useActiveFeature()
  const isStandalone = planFeatures !== undefined
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const editMode = !!defaultValues.id
  const isPublished = planVersion?.status === "published"
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const [isDisplayOpen, setIsDisplayOpen] = useState(false)
  // null until the user touches the price, so an untouched save leaves the card alone.
  // Keyed by the feature, so expanding another card starts from its own untouched price.
  const [priceState, setPriceState] = useState<{
    id: string | undefined
    draft: PriceDraft | null
    problem: string | null
  }>({ id: defaultValues.id, draft: null, problem: null })
  const priceDraft = priceState.id === defaultValues.id ? priceState.draft : null
  const priceProblem = priceState.id === defaultValues.id ? priceState.problem : null
  const setPriceDraft = (draft: PriceDraft | null) =>
    setPriceState({ id: defaultValues.id, draft, problem: null })
  const setPriceProblem = (problem: string | null) =>
    setPriceState((current) => ({
      id: defaultValues.id,
      draft: current.id === defaultValues.id ? current.draft : null,
      problem,
    }))
  const feature = "feature" in defaultValues ? defaultValues.feature : undefined
  const featureMeterTemplate = feature?.meterConfig

  // The feature edited from the sheet: its row in the table and the open sheet read the new one.
  const onFeatureUpdated = (updated: CreatedFeature) => {
    if (isStandalone) return
    setPlanFeatureList((features) =>
      features.map((entry) =>
        entry.featureId === updated.id
          ? { ...entry, feature: { ...entry.feature, ...updated } }
          : entry
      )
    )
    setActiveFeature((current) =>
      current && current.featureId === updated.id
        ? { ...current, feature: { ...current.feature, ...updated } }
        : current
    )
  }
  const featureSlug = feature?.slug ?? activeFeature?.feature.slug ?? ""

  // ADR-0008 D2: the price is a row on the version's card, read beside the package it prices.
  const {
    data: pricing,
    isLoading: isPricingLoading,
    dataUpdatedAt,
  } = useQuery({
    ...trpc.rateCards.forPlanVersion.queryOptions({ planVersionId: planVersion?.id ?? "" }),
    enabled: Boolean(planVersion),
  })
  const card = pricing?.cards.find((entry) => entry.currency === planVersion?.currency)
  const priceRows = rowsByFeature(card?.rows ?? [], dataUpdatedAt).get(featureSlug)

  // Pre-populate every nested field so react-hook-form has a defined value to register against.
  const controlledDefaultValues = {
    ...defaultValues,
    config: {
      ...defaultValues.config,
      usageMode: defaultValues.config?.usageMode ?? "tier",
      units: defaultValues.config?.units ?? 1,
    },
    billingConfig: defaultValues.billingConfig ?? planVersion?.billingConfig,
    meterConfig:
      defaultValues.featureType === "usage"
        ? (defaultValues.meterConfig ?? featureMeterTemplate ?? undefined)
        : null,
    resetConfig: defaultValues.resetConfig ?? {
      name: planVersion?.billingConfig.name,
      planType: planVersion?.billingConfig.planType,
      resetInterval: planVersion?.billingConfig.billingInterval,
      resetIntervalCount: planVersion?.billingConfig.billingIntervalCount,
      resetAnchor: planVersion?.billingConfig.billingAnchor,
    },
    type: defaultValues.type ?? "feature",
    metadata: defaultValues?.metadata ?? {
      hidden: false,
      realtime: false,
      overageStrategy: "none",
    },
  }

  const formSchema = useMemo(
    () =>
      planVersionFeatureInsertBaseSchema.superRefine((data, ctx) => {
        if (data.featureType !== "usage") return

        if (
          data.resetConfig &&
          !isResetCadenceAtMostBilling(data.resetConfig, data.billingConfig)
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Reset cadence must be equal to or shorter than feature billing.",
            path: ["resetConfig", "name"],
          })
        }
      }),
    []
  )

  const form = useZodForm({
    schema: formSchema,
    defaultValues: controlledDefaultValues as PlanVersionFeatureInsert,
  })

  const updatePlanVersionFeatures = useMutation(
    trpc.planVersionFeatures.update.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: ({ planVersionFeature, row }, variables) => {
        // Only the plans-page editor tracks the shared feature list; the standalone sheet
        // must not clobber another page's plan-editor state.
        if (!isStandalone) {
          // A new array, so the table's row and the checklist re-render with the saved feature.
          setPlanFeatureList((features) =>
            features.map((feat) =>
              feat.featureId === planVersionFeature.featureId
                ? { ...feat, ...planVersionFeature }
                : feat
            )
          )
        }

        form.reset(planVersionFeature)
        setPriceDraft(null)
        setPriceProblem(null)
        toastAction("saved")
        setDialogOpen?.(false)
        router.refresh()

        if (variables.price !== undefined && planVersion) {
          // The answered row goes into the pricing cache first, so the header and the block show
          // the new price before the refetch lands.
          queryClient.setQueryData(
            trpc.rateCards.forPlanVersion.queryKey({ planVersionId: planVersion.id }),
            (cached) =>
              cached
                ? {
                    cards: withDefaultRow(cached.cards, planVersion.currency, featureSlug, row),
                  }
                : cached
          )
          void queryClient.invalidateQueries(trpc.rateCards.forPlanVersion.pathFilter())
        }
        if (!isOnboarding) {
          void queryClient.invalidateQueries({
            queryKey: trpc.planVersions.getById.queryKey(),
          })
        }
      },
      // A refusal that names the version's card (another version prices with it) belongs beside
      // the price, next to the card link; every other failure keeps the global toast's form.
      onError: (error, variables) => {
        const cardNamed =
          card && (error.message.includes(card.card.id) || error.message.includes(card.card.name))
        if (variables.price !== undefined && cardNamed) {
          setPriceProblem(error.message)
          return
        }
        toastAction("error", error.message, { requestId: error.data?.requestId })
      },
    })
  )

  // When client-side validation fails, auto-open the collapsible that contains the offending
  // field so the inline FormMessage is visible. We do NOT toast — zod's per-field error already
  // renders next to the input via FormMessage, and a generic toast is noise.
  const onInvalidSubmit = (errors: Record<string, unknown>) => {
    if (errors.billingConfig) setIsAdvancedOpen(true)
    if (
      errors.metadata &&
      typeof errors.metadata === "object" &&
      ("overageStrategy" in (errors.metadata as object) || "hidden" in (errors.metadata as object))
    ) {
      const m = errors.metadata as Record<string, unknown>
      if (m.overageStrategy) setIsAdvancedOpen(true)
      if (m.hidden) setIsDisplayOpen(true)
    }
  }

  // Reset form when the active feature changes (different card expanded).
  useEffect(() => {
    form.reset(controlledDefaultValues)
    // intentionally narrow deps — see existing behavior
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValues.id])

  const featureType = form.watch("featureType") as FeatureType | undefined
  const usageMode = form.watch("config.usageMode")
  const billingConfigName = form.watch("billingConfig.name")
  const overage = form.watch("metadata.overageStrategy") ?? "none"
  const isHidden = form.watch("metadata.hidden") ?? false
  const defaultQuantity = Number(form.watch("defaultQuantity") ?? 0)
  const included = Number(form.watch("included") ?? 0)
  // What a new tiers draft gives away at $0: the quantity picked at signup, or the included units.
  const includedUnits =
    featureType === "tier" ? defaultQuantity : featureType === "usage" ? included : 0

  // A fixed feature the card has no row for is saved at $0, the block's starting amount, so one
  // Save makes it an included feature; the rows must be loaded to know it has none.
  const impliedDraft =
    featureType === "flat" &&
    !isPublished &&
    pricing !== undefined &&
    priceStateOf(priceRows) === "unpriced"
      ? emptyDraft("flat")
      : null
  const shape = featureType ? priceShapeOf(featureType, usageMode) : null

  const onSubmitForm = async (data: PlanVersionFeatureInsert) => {
    if (!defaultValues.id) return
    const draft = priceDraft ?? impliedDraft
    const built = draft ? priceInputOf(draft) : null
    if (built && !built.ok) {
      setPriceProblem(built.message)
      return
    }
    setPriceProblem(null)
    await updatePlanVersionFeatures.mutateAsync({
      ...data,
      id: defaultValues.id,
      ...(built ? { price: built.price } : {}),
    })
  }

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    void form.handleSubmit(onSubmitForm, onInvalidSubmit)(e)
  }

  if (!planVersion) {
    return null
  }

  // ─── one-line summaries shown on each MORE collapsible when collapsed ───
  const advancedSummary = (() => {
    const parts: string[] = []
    if (billingConfigName && billingConfigName !== planVersion.billingConfig.name) {
      parts.push(`Bill: ${billingConfigName}`)
    }
    if (overage !== "none") {
      parts.push(OVERAGE_STRATEGIES_MAP[overage]?.label ?? overage)
    }
    return parts.length > 0 ? parts.join(" · ") : "Defaults"
  })()

  const displaySummary = isHidden ? "Hidden from pricing page" : "Show on pricing page"
  const showAdvanced = featureType === "usage"

  // Derive per-section error state so collapsed sections can flag unresolved validation issues.
  const fieldErrors = form.formState.errors
  const hasAdvancedError = Boolean(
    fieldErrors.billingConfig || fieldErrors.metadata?.overageStrategy
  )
  const hasDisplayError = Boolean(fieldErrors.metadata?.hidden)

  return (
    <Form {...form}>
      <form
        id={"feature-config-form"}
        className={cn("space-y-6", className)}
        onSubmit={handleFormSubmit}
      >
        {/* ─── 1 · How customers pay ─── */}
        <NumberedStep
          number={1}
          label="How customers pay"
          action={
            <div className="flex items-center gap-2">
              {isPublished && (
                <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
                  <Lock className="size-3" />
                  Published
                </span>
              )}
              {feature && (
                <FeatureDialog defaultValues={feature}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-muted-foreground text-xs hover:text-foreground"
                  >
                    <Settings className="size-3" />
                    Edit feature
                  </Button>
                </FeatureDialog>
              )}
            </div>
          }
        >
          <FormField
            control={form.control}
            name="featureType"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <PricingModelPicker
                  value={field.value as FeatureType | undefined}
                  onChange={(value) => {
                    if (isPublished) return
                    field.onChange(value)
                    if (value === "usage") {
                      const current = form.getValues("meterConfig")
                      form.setValue("meterConfig", current ?? featureMeterTemplate ?? undefined)
                    } else {
                      form.setValue("meterConfig", null)
                    }
                  }}
                  isDisabled={isPublished}
                />
                <FormMessage className="self-start" />
              </FormItem>
            )}
          />
        </NumberedStep>

        {/* ─── 2 · Configure (contextual based on selected model) ─── */}
        <NumberedStep
          number={2}
          label="Configure"
          subtitle={getConfigureSubtitle({ featureType, usageMode })}
        >
          <ConfigureFields
            form={form}
            planVersion={planVersion}
            featureSlug={featureSlug}
            unitOfMeasure={defaultValues.unitOfMeasure ?? activeFeature?.unitOfMeasure ?? "units"}
            isDisabled={isPublished}
            featureType={featureType}
            usageMode={usageMode}
            feature={feature}
            onFeatureUpdated={onFeatureUpdated}
            card={card}
            priceRows={priceRows}
            isPricingLoading={isPricingLoading}
            priceDraft={priceDraft}
            onPriceDraftChange={(draft) => {
              setPriceDraft(draft)
              setPriceProblem(null)
            }}
            priceProblem={priceProblem}
            savedDimensions={defaultValues.meterConfig?.groupBy ?? []}
            includedUnits={includedUnits}
            // The table's cells price a fixed, per-unit or bundle feature; the sheet keeps the
            // block for tiers, for the catalog, and for reading a published version's price.
            showPrice={shape === "graduated" || isPublished}
          />
        </NumberedStep>

        {/* ─── 3 · More (collapsible disclosures with one-line summaries) ─── */}
        <NumberedStep number={3} label="More" subtitle="optional">
          <div className="space-y-2">
            {showAdvanced && (
              <CollapsibleSection
                label="Advanced settings"
                summary={advancedSummary}
                open={isAdvancedOpen}
                onOpenChange={setIsAdvancedOpen}
                hasError={hasAdvancedError}
              >
                <div className="space-y-4">
                  <BillingConfigFeatureFormField form={form} isDisabled={isPublished} />
                  <OverageStrategyFormField form={form} isDisabled={isPublished} />
                </div>
              </CollapsibleSection>
            )}

            <CollapsibleSection
              label="Display options"
              summary={displaySummary}
              open={isDisplayOpen}
              onOpenChange={setIsDisplayOpen}
              hasError={hasDisplayError}
            >
              <FormField
                control={form.control}
                name="metadata.hidden"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between gap-3 py-1">
                    <div className="flex items-center gap-1.5">
                      <FormLabel className="font-normal text-sm">Hide from pricing page</FormLabel>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <HelpCircle className="size-3 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-[260px]">
                          When enabled, customers won't see this feature on public pricing pages.
                          Useful for internal or backend features.{" "}
                          <SuperLink
                            href={`${DOCS_DOMAIN}/features/plans`}
                            target="_blank"
                            className="underline-offset-4 hover:underline"
                          >
                            Learn more
                          </SuperLink>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value ?? false}
                        onCheckedChange={field.onChange}
                        disabled={isPublished}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </CollapsibleSection>
          </div>
        </NumberedStep>

        {!isPublished && (
          <div className="-mx-4 flex items-center justify-between gap-3 border-t bg-background-bgSubtle/40 px-4 py-3">
            <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
              <Info className="size-3.5" />
              Changes apply when you publish this version
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant={"link"}
                onClick={(e) => {
                  e.preventDefault()
                  setDialogOpen?.(false)
                }}
              >
                Cancel
              </Button>
              <SubmitButton
                isSubmitting={form.formState.isSubmitting}
                isDisabled={form.formState.isSubmitting}
                label={editMode ? "Update feature" : "Create feature"}
              />
            </div>
          </div>
        )}
      </form>
    </Form>
  )
}

// ─── contextual configure fields per pricing model ───────────────────────
// Prices live on the plan version's rate card (ADR-0008 D2): each model edits the card's row next
// to what the package owns (quantities, limits, the meter, included units), and one Save writes both.
function ConfigureFields({
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
  priceDraft,
  onPriceDraftChange,
  priceProblem,
  savedDimensions,
  includedUnits,
  showPrice,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: react-hook-form's UseFormReturn type doesn't narrow well across schema unions
  form: any
  planVersion: PlanVersion
  featureSlug: string
  unitOfMeasure: string
  isDisabled?: boolean
  featureType: FeatureType | undefined
  usageMode: string | undefined
  /** The catalog feature, whose meter template the version follows unless customized. */
  feature: Feature | undefined
  onFeatureUpdated: (feature: CreatedFeature) => void
  card: PlanVersionCard | undefined
  priceRows: FeaturePriceRows | undefined
  isPricingLoading: boolean
  priceDraft: PriceDraft | null
  onPriceDraftChange: (draft: PriceDraft | null) => void
  priceProblem: string | null
  /** The meter's dimensions as stored; the catalog prices those, not unsaved chips. */
  savedDimensions: readonly string[]
  /** The units a new tiers draft gives away at $0. */
  includedUnits: number
  /** Whether the price block renders; a dimensioned meter always prices from the catalog here. */
  showPrice: boolean
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
      dimension={dimensions.length === 1 ? dimensions[0] : undefined}
      card={card}
      rows={priceRows}
      editable={!isDisabled}
      pendingSave={!dimensions.every((dimension) => savedDimensionSet.has(dimension))}
    />
  ) : showPrice ? (
    <PriceBlockView
      card={card}
      rows={priceRows}
      currency={planVersion.currency}
      unit={unitOfMeasure.replace(/s$/, "")}
      shape={priceShapeOf(featureType, usageMode)}
      editable={!isDisabled}
      isLoading={isPricingLoading}
      draft={priceDraft}
      onDraftChange={onPriceDraftChange}
      problem={priceProblem}
      includedUnits={includedUnits}
    />
  ) : (
    <p className="text-muted-foreground text-xs">The price is set in the feature table.</p>
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
              ? `Per unit only: the price varies by ${dimensions.join(", ")}, and tiers and packages need a meter without dimensions.`
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
  // biome-ignore lint/suspicious/noExplicitAny: shared FormField shape
  form: any
  name: string
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
      render={({ field }: { field: { value: string; onChange: (v: string) => void } }) => (
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
