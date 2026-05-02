"use client"

import { useState } from "react"
import type { UseFormReturn } from "react-hook-form"

import type { Currency, PlanVersionFeatureInsert } from "@unprice/db/validators"

import {
  BillingConfigFeatureFormField,
  LimitFormField,
  OverageStrategyFormField,
  PriceFormField,
  ResetConfigFeatureFormField,
  TierFormField,
  UnitsFormField,
} from "./fields-form"
import { MeterConfigFormField } from "./meter-config-form-field"
import { CollapsibleSection } from "./section-label"

export function UsageFormFields({
  form,
  currency,
  isDisabled,
  units,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  currency: Currency
  isDisabled?: boolean
  units: string
}) {
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const usageMode = form.getValues("config.usageMode")

  return (
    <div className="flex flex-col gap-6">
      {/* Meter — section heading provided by MeterConfigFormField */}
      <MeterConfigFormField form={form} isDisabled={isDisabled} />

      {/* Usage limit (no section heading; single field) */}
      <LimitFormField form={form} isDisabled={isDisabled} units={units} />

      {/* Pricing — Tier section provides its own heading; unit/package keep the field-level label */}
      {usageMode === "unit" && (
        <PriceFormField form={form} currency={currency} isDisabled={isDisabled} />
      )}

      {usageMode === "tier" && (
        <TierFormField form={form} currency={currency} isDisabled={isDisabled} />
      )}

      {usageMode === "package" && (
        <div className="flex w-full flex-col gap-1">
          <PriceFormField form={form} currency={currency} isDisabled={isDisabled} />
          <UnitsFormField form={form} isDisabled={isDisabled} />
        </div>
      )}

      <CollapsibleSection
        label="Advanced settings"
        open={isAdvancedOpen}
        onOpenChange={setIsAdvancedOpen}
      >
        <div className="flex flex-col gap-6 pt-3">
          <BillingConfigFeatureFormField form={form} isDisabled={isDisabled} />
          <ResetConfigFeatureFormField form={form} isDisabled={isDisabled} />
          <OverageStrategyFormField form={form} isDisabled={isDisabled} />
        </div>
      </CollapsibleSection>
    </div>
  )
}
