"use client"

import { FEATURE_SLUGS } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { usePathname, useRouter } from "next/navigation"
import { WorkspaceUpgradeEntrypoint } from "~/components/billing/workspace-upgrade-entrypoint"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { DashboardShell } from "~/components/layout/dashboard-shell"

const BLOCKED_FEATURE_COPY: Record<
  string,
  {
    title: string
    description: string
  }
> = {
  [FEATURE_SLUGS.PROJECTS.SLUG]: {
    title: "Projects are not available on this workspace plan",
    description:
      "Upgrade to create projects that group plans, customers, events, wallets, and invoice evidence.",
  },
  [FEATURE_SLUGS.DOMAINS.SLUG]: {
    title: "Custom domains are not available on this workspace plan",
    description: "Upgrade to verify hostnames before they serve project pages for this workspace.",
  },
  [FEATURE_SLUGS.PAGES.SLUG]: {
    title: "Hosted pages are not available on this workspace plan",
    description:
      "Upgrade to create hosted signup and pricing pages tied to published plan versions.",
  },
  [FEATURE_SLUGS.PLANS.SLUG]: {
    title: "Plans are not available on this workspace plan",
    description: "Upgrade to define plans, plan versions, meters, limits, and billing behavior.",
  },
  [FEATURE_SLUGS.CUSTOMERS.SLUG]: {
    title: "Customers are not available on this workspace plan",
    description:
      "Upgrade to track customer subscriptions, wallet credits, invoices, and budgeted runs.",
  },
  [FEATURE_SLUGS.API_KEYS.SLUG]: {
    title: "API keys are not available on this workspace plan",
    description:
      "Upgrade to create project keys and bind default customers for request-path calls.",
  },
}

export default function UpgradePlanError(props: {
  workspaceSlug: string
  blockedFeatureSlug?: string
  returnTo?: string
  // page-specific copy; the gate should name what the visitor came for, not
  // just the feature that backs it
  title?: string
  description?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const returnTo = props.returnTo ?? pathname
  const featureCopy = props.blockedFeatureSlug
    ? (BLOCKED_FEATURE_COPY[props.blockedFeatureSlug] ?? {
        title: "This dashboard capability is not available on your workspace plan",
        description: "Upgrade the workspace plan to use this dashboard capability.",
      })
    : {
        title: "This dashboard capability is not available on your workspace plan",
        description: "Upgrade the workspace plan to use this dashboard capability.",
      }
  const copy = {
    title: props.title ?? featureCopy.title,
    description: props.description ?? featureCopy.description,
  }

  return (
    <DashboardShell>
      <div className="flex flex-col items-center justify-center">
        <EmptyPlaceholder className="min-h-[520px] w-full">
          <EmptyPlaceholder.Title className="mt-0" variant="h3">
            {copy.title}
          </EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description className="mx-auto max-w-xl text-center">
            {copy.description}
          </EmptyPlaceholder.Description>
          <EmptyPlaceholder.Action>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <WorkspaceUpgradeEntrypoint
                intent={{
                  source: "feature_block",
                  workspaceSlug: props.workspaceSlug,
                  returnTo,
                  blockedFeatureSlug: props.blockedFeatureSlug,
                }}
              >
                Upgrade plan
              </WorkspaceUpgradeEntrypoint>
              <Button variant="default" onClick={() => router.back()}>
                Go back
              </Button>
            </div>
          </EmptyPlaceholder.Action>
        </EmptyPlaceholder>
      </div>
    </DashboardShell>
  )
}
