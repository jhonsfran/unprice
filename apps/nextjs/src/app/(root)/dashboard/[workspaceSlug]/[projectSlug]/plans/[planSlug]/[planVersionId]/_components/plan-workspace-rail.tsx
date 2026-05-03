import type React from "react"

import { Pencil } from "lucide-react"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Separator } from "@unprice/ui/separator"
import { cn } from "@unprice/ui/utils"

import { PricingCard } from "~/components/forms/pricing-card"
import { PlanVersionDialog } from "../../_components/plan-version-dialog"

export function PlanWorkspaceRail({
  planVersion,
}: {
  planVersion: RouterOutputs["planVersions"]["getById"]["planVersion"]
}) {
  if (!planVersion) return null

  const status = planVersion.status ?? "draft"
  const trialUnit = planVersion.billingConfig.billingInterval
  const trialLabel =
    planVersion.trialUnits === 0
      ? "no trial"
      : `${planVersion.trialUnits} ${trialUnit}${planVersion.trialUnits === 1 ? "" : "s"}`

  const items: Array<[string, React.ReactNode]> = [
    ["Status", <StatusDot key="status" status={status} />],
    ["Currency", planVersion.currency],
    ["Billing", planVersion.billingConfig.name],
    ["Trial", trialLabel],
    ["Provider", planVersion.paymentProvider],
    ["Plan type", planVersion.billingConfig.planType],
  ]

  return (
    <div className="flex flex-col gap-6 p-4">
      <section className="flex flex-col gap-3">
        <SectionTitle>Customer preview</SectionTitle>
        <PricingCard planVersion={planVersion} className="w-full" showPublish={false} />
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <SectionTitle>Plan settings</SectionTitle>

        <div className="rounded-md border bg-background-bgSubtle">
          {items.map(([label, value], i) => (
            <div
              key={label}
              className={cn(
                "flex items-center justify-between px-3 py-2 text-xs",
                i < items.length - 1 && "border-b"
              )}
            >
              <span className="text-muted-foreground">{label}</span>
              <span className="font-mono text-foreground">{value}</span>
            </div>
          ))}
        </div>

        <PlanVersionDialog
          defaultValues={{
            ...planVersion,
            isDefault: planVersion.plan.defaultPlan ?? false,
          }}
        >
          <Button variant="ghost" size="sm" className="w-full justify-center gap-2">
            <Pencil className="h-3.5 w-3.5" />
            Edit plan settings
          </Button>
        </PlanVersionDialog>
      </section>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
      {children}
    </h4>
  )
}

function StatusDot({ status }: { status: string }) {
  const isPublished = status === "published"
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 font-mono text-xs", {
        "text-success": isPublished,
        "text-info": !isPublished,
      })}
    >
      <span
        className={cn("h-1.5 w-1.5 rounded-full", {
          "bg-success-solid": isPublished,
          "bg-info": !isPublished,
        })}
      />
      {status}
    </span>
  )
}
