"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Info, Lock, Settings } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

import { DOCS_DOMAIN } from "@unprice/config"
import {
  OVERAGE_STRATEGIES_MAP,
  TIER_MODES,
  TIER_MODES_MAP,
  USAGE_MODES,
  USAGE_MODES_MAP,
} from "@unprice/db/utils"
import type { FeatureType } from "@unprice/db/utils"
import type {
  PlanVersion,
  PlanVersionFeature,
  PlanVersionFeatureDragDrop,
  PlanVersionFeatureInsert,
} from "@unprice/db/validators"
import { planVersionFeatureInsertBaseSchema } from "@unprice/db/validators"
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
  LimitFormField,
  OverageStrategyFormField,
  PriceFormField,
  QuantityFormField,
  ResetConfigFeatureFormField,
  TierFormField,
  UnitsFormField,
} from "./fields-form"
import { MeterConfigFormField } from "./meter-config-form-field"
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
  className,
}: {
  defaultValues: PlanVersionFeatureInsert | PlanVersionFeature | PlanVersionFeatureDragDrop
  planVersion: PlanVersion | null
  setDialogOpen?: (open: boolean) => void
  className?: string
}) {
  const router = useRouter()
  const [_planFeatureList, setPlanFeatureList] = usePlanFeaturesList()
  const [isOnboarding] = useIsOnboarding()
  const [activeFeature] = useActiveFeature()
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
      tiers: defaultValues.config?.tiers ?? [
        {
          firstUnit: 1,
          lastUnit: null,
          unitPrice: {
            displayAmount: "0.00",
            dinero: {
              amount: 0,
              currency: {
                code: planVersion?.currency ?? "USD",
                base: 10,
                exponent: 2,
              },
              scale: 2,
            },
          },
          flatPrice: {
            displayAmount: "0.00",
            dinero: {
              amount: 0,
              currency: {
                code: planVersion?.currency ?? "USD",
                base: 10,
                exponent: 2,
              },
              scale: 2,
            },
          },
        },
      ],
      usageMode: defaultValues.config?.usageMode ?? "tier",
      tierMode: defaultValues.config?.tierMode ?? "volume",
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

  const form = useZodForm({
    schema: planVersionFeatureInsertBaseSchema,
    defaultValues: controlledDefaultValues as PlanVersionFeatureInsert,
  })

  const updatePlanVersionFeatures = useMutation(
    trpc.planVersionFeatures.update.mutationOptions({
      onSuccess: ({ planVersionFeature }) => {
        setPlanFeatureList((features) => {
          const index = features.findIndex(
            (feat) => feat.featureId === planVersionFeature.featureId
          )
          features[index] = planVersionFeature
          return features
        })

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
      onError: (error) => {
        console.error(error)
        toastAction("error", error.message ?? "Failed to update feature")
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

  // Convert a displayAmount string ("10.00") into the dinero shape the schema expects.
  // Inputs only write displayAmount — we derive the canonical numeric representation here
  // so the schema's `price.dinero: Required` check is satisfied.
  const toDineroShape = (displayAmount: unknown) => {
    const raw =
      typeof displayAmount === "number"
        ? displayAmount
        : typeof displayAmount === "string"
          ? Number.parseFloat(displayAmount)
          : Number.NaN
    if (!Number.isFinite(raw)) return undefined
    const exponent = 2
    return {
      amount: Math.round(raw * 10 ** exponent),
      currency: { code: planVersion.currency, base: 10, exponent },
      scale: exponent,
    }
  }

  // Force tier `firstUnit` values to be continuous (1 → prev.lastUnit + 1) AND keep every
  // displayAmount in sync with its dinero counterpart BEFORE the resolver runs.
  const normalizeBeforeSubmit = () => {
    // Tier firstUnit continuity (we dropped the firstUnit input from the table)
    const tiers = form.getValues("config.tiers")
    if (Array.isArray(tiers)) {
      tiers.forEach((_, i) => {
        const expected =
          i === 0
            ? 1
            : (() => {
                const raw = form.getValues(`config.tiers.${i - 1}.lastUnit`)
                const parsed = Number(raw)
                return Number.isFinite(parsed) ? parsed + 1 : undefined
              })()
        if (typeof expected === "number") {
          form.setValue(`config.tiers.${i}.firstUnit`, expected, {
            shouldValidate: false,
            shouldDirty: false,
          })
        }
      })

      // Sync each tier's flatPrice.dinero and unitPrice.dinero from their displayAmount
      tiers.forEach((_, i) => {
        const flatDisp = form.getValues(`config.tiers.${i}.flatPrice.displayAmount`)
        const flatDinero = toDineroShape(flatDisp)
        if (flatDinero) {
          form.setValue(`config.tiers.${i}.flatPrice.dinero`, flatDinero, {
            shouldValidate: false,
            shouldDirty: false,
          })
        }
        const unitDisp = form.getValues(`config.tiers.${i}.unitPrice.displayAmount`)
        const unitDinero = toDineroShape(unitDisp)
        if (unitDinero) {
          form.setValue(`config.tiers.${i}.unitPrice.dinero`, unitDinero, {
            shouldValidate: false,
            shouldDirty: false,
          })
        }
      })
    }

    // Sync top-level config.price.dinero from displayAmount (flat / package / usage>unit / usage>package)
    const priceDisp = form.getValues("config.price.displayAmount")
    if (typeof priceDisp !== "undefined") {
      const dinero = toDineroShape(priceDisp)
      if (dinero) {
        form.setValue("config.price.dinero", dinero, {
          shouldValidate: false,
          shouldDirty: false,
        })
      }
    }
  }

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    normalizeBeforeSubmit()
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
            currency={planVersion.currency}
            unitOfMeasure={activeFeature?.unitOfMeasure ?? "units"}
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
function ConfigureFields({
  form,
  currency,
  unitOfMeasure,
  isDisabled,
  featureType,
  usageMode,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: react-hook-form's UseFormReturn type doesn't narrow well across schema unions
  form: any
  currency: PlanVersion["currency"]
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

  if (featureType === "flat") {
    return <PriceFormField form={form} currency={currency} isDisabled={isDisabled} />
  }

  if (featureType === "package") {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <PriceFormField
            form={form}
            currency={currency}
            isDisabled={isDisabled}
            label="Price per bundle"
          />
          <UnitsFormField form={form} isDisabled={isDisabled} />
        </div>
        <QuantityFormField form={form} isDisabled={isDisabled} />
      </div>
    )
  }

  if (featureType === "tier") {
    return (
      <div className="space-y-4">
        <ModeSelect
          form={form}
          name="config.tierMode"
          label="Tier mode"
          tooltip="How tiered prices apply to the chosen quantity."
          isDisabled={isDisabled}
          options={TIER_MODES.map((m) => ({
            value: m,
            label: TIER_MODES_MAP[m].label,
            description: TIER_MODES_MAP[m].description,
          }))}
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <QuantityFormField form={form} isDisabled={isDisabled} />
          <LimitFormField form={form} isDisabled={isDisabled} units={unitOfMeasure} />
        </div>
        <TierFormField form={form} currency={currency} isDisabled={isDisabled} />
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
          tooltip="How consumed usage maps to a price."
          isDisabled={isDisabled}
          options={USAGE_MODES.map((m) => ({
            value: m,
            label: USAGE_MODE_FRIENDLY_LABEL[m] ?? USAGE_MODES_MAP[m].label,
            description: USAGE_MODES_MAP[m].description,
          }))}
        />
        {usageMode === "tier" && (
          <ModeSelect
            form={form}
            name="config.tierMode"
            label="Tier mode"
            tooltip="How tiered usage prices apply."
            isDisabled={isDisabled}
            options={TIER_MODES.map((m) => ({
              value: m,
              label: TIER_MODES_MAP[m].label,
              description: TIER_MODES_MAP[m].description,
            }))}
          />
        )}
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

      <LimitFormField form={form} isDisabled={isDisabled} units={unitOfMeasure} />

      {usageMode === "unit" && (
        <PriceFormField
          form={form}
          currency={currency}
          isDisabled={isDisabled}
          label="Price per unit"
        />
      )}
      {usageMode === "tier" && (
        <TierFormField form={form} currency={currency} isDisabled={isDisabled} />
      )}
      {usageMode === "package" && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <PriceFormField
            form={form}
            currency={currency}
            isDisabled={isDisabled}
            label="Price per bundle"
          />
          <UnitsFormField form={form} isDisabled={isDisabled} />
        </div>
      )}
    </div>
  )
}

// ─── small inline mode select used for tierMode / usageMode ──────────────
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
