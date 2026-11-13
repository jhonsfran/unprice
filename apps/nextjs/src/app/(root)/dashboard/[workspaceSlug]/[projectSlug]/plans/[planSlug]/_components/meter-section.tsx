"use client"

import type { Feature, MeterConfig, PlanVersionFeatureInsert } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Settings } from "lucide-react"
import { useState } from "react"
import type { UseFormReturn } from "react-hook-form"

import { CollapsibleSection } from "~/components/pricing/section-label"
import { FeatureDialog } from "../../_components/feature-dialog"
import type { CreatedFeature } from "../../_components/feature-form"
import { MeterConfigFormField } from "./meter-config-form-field"
import { meterMatchesTemplate, meterSummary } from "./meter-template"

/**
 * The meter of a metered feature on a version. While the version measures what the feature's
 * template measures, it reads as one line: the template is edited on the feature, and a
 * disclosure customizes this version alone. A feature without a template gets the full form.
 */
export function MeterSection({
  form,
  feature,
  isDisabled,
  onFeatureUpdated,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  feature: Feature | undefined
  isDisabled?: boolean
  /** Where the edited feature goes, such as the table's row for it. */
  onFeatureUpdated?: (feature: CreatedFeature) => void
}) {
  const [template, setTemplate] = useState<MeterConfig | null>(feature?.meterConfig ?? null)
  const meter = form.watch("meterConfig")
  const follows = meterMatchesTemplate(meter, template)
  const [customizing, setCustomizing] = useState(!follows)
  const [editing, setEditing] = useState(false)

  if (!template) {
    return (
      <div className="space-y-3 rounded-md border bg-background-bgSubtle/40 p-3">
        <div className="flex items-center gap-1.5">
          <h5 className="font-semibold text-foreground text-xs uppercase tracking-wider">Meter</h5>
          <span className="text-muted-foreground text-xs normal-case tracking-normal">
            required
          </span>
        </div>
        <MeterConfigFormField form={form} isDisabled={isDisabled} />
      </div>
    )
  }

  const useTemplate = () => {
    form.setValue("meterConfig", template, { shouldDirty: true, shouldValidate: true })
    setCustomizing(false)
  }

  return (
    <div className="space-y-3 rounded-md border bg-background-bgSubtle/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm">
          {follows ? (
            <>
              Measured by <span className="font-medium">{meterSummary(template)}</span>
            </>
          ) : (
            <>
              Custom for this version
              {meter && <span className="text-muted-foreground"> · {meterSummary(meter)}</span>}
            </>
          )}
        </p>
        {!isDisabled &&
          (follows ? (
            feature && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 gap-1 px-2 text-muted-foreground text-xs hover:text-foreground"
                onClick={() => setEditing(true)}
              >
                <Settings className="size-3" />
                Edit on feature
              </Button>
            )
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-muted-foreground text-xs hover:text-foreground"
              onClick={useTemplate}
            >
              Use the feature's meter
            </Button>
          ))}
      </div>
      <CollapsibleSection
        label="Customize for this version"
        open={customizing}
        onOpenChange={setCustomizing}
      >
        <MeterConfigFormField form={form} isDisabled={isDisabled} />
      </CollapsibleSection>
      {feature && (
        <FeatureDialog
          open={editing}
          onOpenChange={setEditing}
          defaultValues={{ ...feature, meterConfig: template }}
          onUpdated={(updated) => {
            const next = updated.meterConfig ?? null
            // A version that followed the template keeps following it.
            if (follows && next) {
              form.setValue("meterConfig", next, { shouldDirty: true, shouldValidate: true })
            }
            setTemplate(next)
            onFeatureUpdated?.(updated)
          }}
        />
      )}
    </div>
  )
}
