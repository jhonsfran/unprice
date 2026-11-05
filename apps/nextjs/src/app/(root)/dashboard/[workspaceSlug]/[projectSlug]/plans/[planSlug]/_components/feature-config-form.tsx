"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Info, Lock, Settings } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState } from "react"

import { DOCS_DOMAIN } from "@unprice/config"
import { OVERAGE_STRATEGIES_MAP, USAGE_MODES, USAGE_MODES_MAP } from "@unprice/db/utils"
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
import {
  BillingConfigFeatureFormField,
  IncludedFormField,
  LimitFormField,
  OverageStrategyFormField,
  QuantityFormField,
  ResetConfigFeatureFormField,
  UnitsFormField,
} from "./fields-form"
import { MeterConfigFormField } from "./meter-config-form-field"
import { PricedByCard } from "./priced-by-card"
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
  const [activeFeature] = useActiveFeature()
  const isStandalone = planFeatures !== undefined
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const editMode = !!defaultValues.id
  const isPublished = planVersion?.status === "published"
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const [isDisplayOpen, setIsDisplayOpen] = useState(false)
  const feature = "feature" in defaultValues ? defaultValues.feature : undefined
  const featureMeterTemplate = feature?.meterConfig

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
      onSuccess: ({ planVersionFeature }) => {
        // Only the plans-page editor tracks the shared feature list; the standalone sheet
        // must not clobber another page's plan-editor state.
        if (!isStandalone) {
          setPlanFeatureList((features) => {
            const index = features.findIndex(
              (feat) => feat.featureId === planVersionFeature.featureId
            )
            features[index] = planVersionFeature
            return features
          })
        }

        form.reset(planVersionFeature)
        toastAction("saved")
        setDialogOpen?.(false)
        router.refresh()

        if (!isOnboarding) {
          void queryClient.invalidateQueries({
            queryKey: trpc.planVersions.getById.queryKey(),
          })
        }
      },
    })
  )

  // When client-side validation fails, auto-open the collapsible that contains the offending
  // field so the inline FormMessage is visible. We do NOT toast — zod's per-field error already
  // renders next to the input via FormMessage, and a generic toast is noise.
  const onInvalidSubmit = (errors: Record<string, unknown>) => {
    if (errors.billingConfig || errors.resetConfig) setIsAdvancedOpen(true)
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
  const resetConfigName = form.watch("resetConfig.name")
  const overage = form.watch("metadata.overageStrategy") ?? "none"
  const isHidden = form.watch("metadata.hidden") ?? false

  const onSubmitForm = async (data: PlanVersionFeatureInsert) => {
    if (defaultValues.id) {
      await updatePlanVersionFeatures.mutateAsync({
        ...data,
        id: defaultValues.id,
      })
    }
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
    if (resetConfigName && resetConfigName !== planVersion.billingConfig.name) {
      parts.push(`Reset: ${resetConfigName}`)
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
    fieldErrors.billingConfig || fieldErrors.resetConfig || fieldErrors.metadata?.overageStrategy
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
            featureSlug={feature?.slug ?? activeFeature?.feature.slug ?? ""}
            unitOfMeasure={defaultValues.unitOfMeasure ?? activeFeature?.unitOfMeasure ?? "units"}
            isDisabled={isPublished}
            featureType={featureType}
            usageMode={usageMode}
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
                  <ResetConfigFeatureFormField form={form} isDisabled={isPublished} />
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
// Prices live on the plan version's rate card (ADR-0008 D2): each model shows the card's price
// and keeps only what the package owns (quantities, limits, the meter, included units).
function ConfigureFields({
  form,
  planVersion,
  featureSlug,
  unitOfMeasure,
  isDisabled,
  featureType,
  usageMode,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: react-hook-form's UseFormReturn type doesn't narrow well across schema unions
  form: any
  planVersion: PlanVersion
  featureSlug: string
  unitOfMeasure: string
  isDisabled?: boolean
  featureType: FeatureType | undefined
  usageMode: string | undefined
}) {
  if (!featureType) {
    return (
      <p className="text-muted-foreground text-sm italic">Pick a pricing model above to start.</p>
    )
  }

  const price = (
    <PricedByCard
      planVersionId={planVersion.id}
      featureSlug={featureSlug}
      currency={planVersion.currency}
      unit={unitOfMeasure.replace(/s$/, "")}
    />
  )

  if (featureType === "flat") return price

  if (featureType === "package") {
    return (
      <div className="space-y-4">
        {price}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <UnitsFormField form={form} isDisabled={isDisabled} />
          <QuantityFormField form={form} isDisabled={isDisabled} />
        </div>
      </div>
    )
  }

  if (featureType === "tier") {
    return (
      <div className="space-y-4">
        {price}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <QuantityFormField form={form} isDisabled={isDisabled} />
          <LimitFormField form={form} isDisabled={isDisabled} units={unitOfMeasure} />
        </div>
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
          tooltip="How consumed usage maps to a price. The rate card row holds the price itself."
          isDisabled={isDisabled}
          options={USAGE_MODES.map((m) => ({
            value: m,
            label: USAGE_MODE_FRIENDLY_LABEL[m] ?? USAGE_MODES_MAP[m].label,
            description: USAGE_MODES_MAP[m].description,
          }))}
        />
        {usageMode === "package" && <UnitsFormField form={form} isDisabled={isDisabled} />}
      </div>

      {/* Meter is required for usage features — render inline so its errors are always visible */}
      <div className="space-y-3 rounded-md border bg-background-bgSubtle/40 p-3">
        <div className="flex items-center gap-1.5">
          <h5 className="font-semibold text-foreground text-xs uppercase tracking-wider">Meter</h5>
          <span className="text-muted-foreground text-xs normal-case tracking-normal">
            required
          </span>
        </div>
        <MeterConfigFormField form={form} isDisabled={isDisabled} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <LimitFormField form={form} isDisabled={isDisabled} units={unitOfMeasure} />
        <IncludedFormField form={form} isDisabled={isDisabled} units={unitOfMeasure} />
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
}: {
  // biome-ignore lint/suspicious/noExplicitAny: shared FormField shape
  form: any
  name: string
  label: string
  tooltip?: string
  options: Array<{ value: string; label: string; description?: string }>
  isDisabled?: boolean
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
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
