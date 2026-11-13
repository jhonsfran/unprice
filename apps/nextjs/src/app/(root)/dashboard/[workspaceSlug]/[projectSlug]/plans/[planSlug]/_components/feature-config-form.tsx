"use client"

import type { RouterOutputs } from "@unprice/trpc/routes"

import { Info, Lock, Settings } from "lucide-react"
import { useMemo, useState } from "react"
import { useUpdatePlanFeature } from "~/components/pricing/use-update-plan-feature"
import { useVersionPricing } from "~/components/pricing/use-version-pricing"

import { DOCS_DOMAIN } from "@unprice/config"
import { OVERAGE_STRATEGIES_MAP } from "@unprice/db/utils"
import type { FeatureType } from "@unprice/db/utils"
import type {
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
import { Switch } from "@unprice/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"

import { SubmitButton } from "~/components/submit-button"
import { SuperLink } from "~/components/super-link"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"

import { priceStateOf } from "~/components/pricing/plan-prices"
import { CollapsibleSection, NumberedStep } from "~/components/pricing/section-label"
import { FeatureDialog } from "../../_components/feature-dialog"
import type { CreatedFeature } from "../../_components/feature-form"
import { ConfigureFields } from "./feature-config-fields"
import { BillingConfigFeatureFormField, OverageStrategyFormField } from "./fields-form"
import { type PriceDraft, emptyDraft, priceInputOf } from "./price-block"
import { PricingModelPicker, getConfigureSubtitle } from "./pricing-model"

export function FeatureConfigForm({
  setDialogOpen,
  defaultValues,
  planVersion,
  onSaved,
  onFeatureUpdated,
  className,
}: {
  defaultValues: PlanVersionFeatureInsert | PlanVersionFeature | PlanVersionFeatureDragDrop
  planVersion: PlanVersion | null
  onSaved?: (feature: RouterOutputs["planVersionFeatures"]["update"]["planVersionFeature"]) => void
  onFeatureUpdated?: (feature: CreatedFeature) => void
  setDialogOpen?: (open: boolean) => void
  className?: string
}) {
  const editMode = !!defaultValues.id
  const isPublished = planVersion?.status === "published"
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const [isDisplayOpen, setIsDisplayOpen] = useState(false)
  const [priceDraft, setPriceDraft] = useState<PriceDraft | null>(null)
  const [priceProblem, setPriceProblem] = useState<string | null>(null)
  const feature = "feature" in defaultValues ? defaultValues.feature : undefined
  const featureMeterTemplate = feature?.meterConfig

  const featureSlug = feature?.slug ?? ""

  // ADR-0008 D2: the price is a row on the version's card, read beside the package it prices.
  const {
    card,
    rows,
    isLoading: isPricingLoading,
    now: pricingNow,
  } = useVersionPricing(planVersion?.id, planVersion?.currency)
  const priceRows = rows.get(featureSlug)

  // Pre-populate every nested field so react-hook-form has a defined value to register against.
  const controlledDefaultValues = {
    ...defaultValues,
    config: {
      ...defaultValues.config,
      // A new metered feature starts as one price per unit; tiers and bundles are a choice.
      usageMode:
        defaultValues.config?.usageMode ??
        (defaultValues.featureType === "usage" ? "unit" : "tier"),
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

  const updatePlanVersionFeatures = useUpdatePlanFeature({
    currency: planVersion?.currency,
    onSaved: (planVersionFeature) => {
      onSaved?.(planVersionFeature)
      form.reset(planVersionFeature)
      setPriceDraft(null)
      setPriceProblem(null)
      toastAction("saved")
      setDialogOpen?.(false)
    },
  })
  const updateOptions = {
    onError: (error, variables) => {
      if (variables.price !== undefined && error.data?.domainCode === "CARD_SHARED") {
        setPriceProblem(error.message)
        return
      }
      toastAction("error", error.message, { requestId: error.data?.requestId })
    },
  } satisfies Parameters<typeof updatePlanVersionFeatures.mutate>[1]

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
    pricingNow > 0 &&
    priceStateOf(priceRows) === "unpriced"
      ? emptyDraft("flat")
      : null

  const onSubmitForm = async (data: PlanVersionFeatureInsert) => {
    if (!defaultValues.id) return
    const draft = priceDraft ?? impliedDraft
    const built = draft ? priceInputOf(draft) : null
    if (built && !built.ok) {
      setPriceProblem(built.message)
      return
    }
    setPriceProblem(null)
    await updatePlanVersionFeatures.mutateAsync(
      {
        ...data,
        id: defaultValues.id,
        ...(built ? { price: built.price } : {}),
      },
      updateOptions
    )
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
                      if (field.value !== "usage") {
                        form.setValue("config.usageMode", "unit", { shouldDirty: true })
                      }
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
            unitOfMeasure={defaultValues.unitOfMeasure ?? "units"}
            isDisabled={isPublished}
            featureType={featureType}
            usageMode={usageMode}
            feature={feature}
            onFeatureUpdated={onFeatureUpdated}
            card={card}
            priceRows={priceRows}
            isPricingLoading={isPricingLoading}
            pricingNow={pricingNow}
            priceDraft={priceDraft}
            onPriceDraftChange={(draft) => {
              setPriceDraft(draft)
              setPriceProblem(null)
            }}
            priceProblem={priceProblem}
            savedDimensions={defaultValues.meterConfig?.groupBy ?? []}
            includedUnits={includedUnits}
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
