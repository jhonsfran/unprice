"use client"

import { ScrollArea } from "@unprice/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@unprice/ui/sheet"

import { useActiveFeature, useActivePlanVersion, usePlanFeaturesList } from "~/hooks/use-features"
import { FeatureConfigForm } from "./feature-config-form"

/**
 * The side sheet for the active feature: what a table cell cannot hold (the meter and its
 * dimensions, tiers, a bundle's size, cadences, overage, display, the catalog). Opening sets the
 * active feature; Save or Cancel clears it.
 */
export function FeatureSheet() {
  const [activeFeature, setActiveFeature] = useActiveFeature()
  const [, setPlanFeatureList] = usePlanFeaturesList()
  const [planVersion] = useActivePlanVersion()
  const open = Boolean(activeFeature && planVersion)

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setActiveFeature(null)
      }}
    >
      <SheetContent className="w-full overflow-hidden p-0 md:w-2/3 lg:w-[760px]">
        {activeFeature && planVersion && (
          <ScrollArea className="w-full" style={{ height: "100dvh", maxHeight: "100dvh" }}>
            <div className="p-6">
              <SheetHeader className="pr-6">
                <SheetTitle>{activeFeature.feature.title}</SheetTitle>
                <SheetDescription className="break-all font-mono text-xs">
                  {activeFeature.feature.slug}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-6 pb-6">
                <FeatureConfigForm
                  key={activeFeature.id ?? activeFeature.featureId}
                  onSaved={(saved) =>
                    setPlanFeatureList((features) =>
                      features.map((entry) =>
                        entry.featureId === saved.featureId ? { ...entry, ...saved } : entry
                      )
                    )
                  }
                  onFeatureUpdated={(updated) => {
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
                  }}
                  defaultValues={activeFeature}
                  planVersion={planVersion}
                  setDialogOpen={(next) => {
                    if (!next) setActiveFeature(null)
                  }}
                />
              </div>
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  )
}
