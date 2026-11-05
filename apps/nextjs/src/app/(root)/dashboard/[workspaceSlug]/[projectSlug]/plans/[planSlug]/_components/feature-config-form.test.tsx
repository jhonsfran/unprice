import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createTRPCClient, httpLink } from "@trpc/client"
import type { PlanVersion, PlanVersionFeatureDragDrop } from "@unprice/db/validators"
import type { AppRouter } from "@unprice/trpc/routes"
import { transformer } from "@unprice/trpc/transformer"
import { TooltipProvider } from "@unprice/ui/tooltip"
import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { TRPCProvider } from "~/trpc/client"
import { FeatureConfigForm } from "./feature-config-form"

// The form refreshes the router and links the card; neither is what these tests check.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  useParams: () => ({
    workspaceSlug: "ws",
    projectSlug: "proj",
    planSlug: "pro",
    planVersionId: "pv_1",
  }),
}))
vi.mock("~/components/super-link", () => ({
  SuperLink: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}))
// `useFormStatus` ships with the React that Next bundles, not with the test renderer's react-dom.
vi.mock("~/components/submit-button", () => ({
  SubmitButton: ({ label }: { label: string }) => <button type="submit">{label}</button>,
}))

const billingConfig = {
  name: "monthly",
  billingInterval: "month" as const,
  billingIntervalCount: 1,
  billingAnchor: "dayOfCreation" as const,
  planType: "recurring" as const,
}

const planVersion = {
  id: "pv_1",
  projectId: "proj_1",
  planId: "plan_1",
  version: 1,
  status: "draft",
  currency: "USD",
  billingConfig,
  trialUnits: 0,
  paymentProvider: "sandbox",
  active: true,
} as unknown as PlanVersion

const apiCalls = {
  id: "pvf_api",
  projectId: "proj_1",
  planVersionId: "pv_1",
  featureId: "feat_api",
  featureType: "usage",
  config: { usageMode: "unit" },
  metadata: { hidden: false, realtime: false, overageStrategy: "none" },
  order: 1024,
  defaultQuantity: 1,
  unitOfMeasure: "calls",
  billingConfig,
  resetConfig: {
    name: "monthly",
    resetInterval: "month",
    resetIntervalCount: 1,
    resetAnchor: "dayOfCreation",
    planType: "recurring",
  },
  included: "1000",
  limit: null,
  meterConfig: { eventId: "evt_1", eventSlug: "api_calls", aggregationMethod: "count" },
  feature: {
    id: "feat_api",
    projectId: "proj_1",
    slug: "api-calls",
    title: "API calls",
    description: null,
    unitOfMeasure: "calls",
    meterConfig: null,
    createdAtM: 0,
    updatedAtM: 0,
  },
} as unknown as PlanVersionFeatureDragDrop

function render(defaultValues: PlanVersionFeatureDragDrop) {
  const queryClient = new QueryClient()
  const trpcClient = createTRPCClient<AppRouter>({
    links: [httpLink({ url: "http://localhost/unused", transformer })],
  })

  return renderToString(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <TooltipProvider>
          <FeatureConfigForm defaultValues={defaultValues} planVersion={planVersion} />
        </TooltipProvider>
      </TRPCProvider>
    </QueryClientProvider>
  ).replace(/<!-- -->/g, "")
}

describe("FeatureConfigForm", () => {
  it("puts a metered feature's reset cadence beside its limit, not under Advanced", () => {
    const html = render(apiCalls)

    const limit = html.indexOf("Usage Limit")
    const reset = html.indexOf("Usage Reset")
    const advanced = html.indexOf("Advanced settings")
    expect(limit).toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(limit)
    expect(reset).toBeLessThan(advanced)
    // Advanced is collapsed, so what it holds is not rendered; Resets is.
    expect(html).not.toContain("Feature Billing")
  })

  it("leaves a per-unit price to the table and says so", () => {
    const html = render(apiCalls)

    expect(html).toContain("The price is set in the feature table.")
    expect(html).not.toContain('id="feature-price"')
  })

  it("keeps the price block for tiers", () => {
    const html = render({
      ...apiCalls,
      config: { usageMode: "tier" },
    } as PlanVersionFeatureDragDrop)

    expect(html).not.toContain("The price is set in the feature table.")
  })
})
