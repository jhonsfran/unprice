import type { Customer } from "@unprice/db/validators"
import { Err, FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { getCustomerCurrentAccessMock, getCustomerWalletMock, getUsageDashboardMock } = vi.hoisted(
  () => ({
    getCustomerCurrentAccessMock: vi.fn(),
    getCustomerWalletMock: vi.fn(),
    getUsageDashboardMock: vi.fn(),
  })
)

vi.mock("../customer/get-current-access", async () => {
  const actual = await vi.importActual<typeof import("../customer/get-current-access")>(
    "../customer/get-current-access"
  )
  return { ...actual, getCustomerCurrentAccess: getCustomerCurrentAccessMock }
})

vi.mock("../wallet/get-customer-wallet", async () => {
  const actual = await vi.importActual<typeof import("../wallet/get-customer-wallet")>(
    "../wallet/get-customer-wallet"
  )
  return { ...actual, getCustomerWallet: getCustomerWalletMock }
})

vi.mock("../analytics/get-usage-dashboard", async () => {
  const actual = await vi.importActual<typeof import("../analytics/get-usage-dashboard")>(
    "../analytics/get-usage-dashboard"
  )
  return { ...actual, getUsageDashboard: getUsageDashboardMock }
})

import { GetWorkspaceBillingOverviewError, getWorkspaceBillingOverview } from "./get-billing-overview"

const now = Date.parse("2026-07-04T10:00:00.000Z")

function createLogger(): Logger {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: "cus_workspace",
    projectId: "proj_billing",
    email: "billing@example.com",
    name: "Example Customer",
    description: null,
    externalId: null,
    metadata: {},
    active: true,
    isMain: false,
    defaultCurrency: "USD",
    timezone: "UTC",
    createdAtM: now,
    updatedAtM: now,
    ...overrides,
  } as Customer
}

function createAccess() {
  return {
    customerId: "cus_workspace",
    generatedAt: now,
    activePlan: {
      subscriptionId: "sub_123",
      planSlug: "pro",
      status: "active",
      currentCycleStartAt: now - 1000,
      currentCycleEndAt: now + 86_400_000,
      renewAt: now + 86_400_000,
      timezone: "UTC",
      activePhase: {
        id: "phase_current",
        planVersionId: "pv_current",
        paymentMethodId: "pm_123",
        creditLinePolicy: "uncapped",
        creditLineAmount: null,
        paymentProvider: "stripe" as const,
        startAt: now - 1000,
        endAt: null,
        planVersion: {
          id: "pv_current",
          version: 1,
          billingConfig: {
            name: "Monthly",
            billingInterval: "month" as const,
            billingIntervalCount: 1,
            billingAnchor: "dayOfCreation" as const,
            planType: "recurring" as const,
          },
        },
      },
    },
    activeSubscriptionCount: 1,
    entitlementCount: 0,
    usageUnavailable: false,
    usageWindow: { start: now - 1000, end: now },
    entitlements: [],
  }
}

function createWallet() {
  return {
    customer: createCustomer(),
    wallet: {
      currency: "USD" as const,
      balances: {
        purchased: 1_000,
        granted: 500,
        reserved: 0,
        consumed: 0,
        walletConsumed: 0,
        subscriptionCharges: 0,
      },
      credits: [],
    },
  }
}

function createDeps(overrides?: { customer?: Customer | null }) {
  const logger = createLogger()
  const getCustomerByIdAcrossProjects = vi
    .fn()
    .mockResolvedValue(
      Ok(overrides?.customer === undefined ? createCustomer() : overrides.customer)
    )

  const deps = {
    services: {
      customers: { getCustomerByIdAcrossProjects },
      wallet: {},
    },
    db: {},
    analytics: {},
    logger,
    now: () => now,
  }

  return { deps, logger, getCustomerByIdAcrossProjects }
}

function createInput(unPriceCustomerId: string | null = "cus_workspace") {
  return {
    workspace: {
      id: "ws_123",
      slug: "acme",
      unPriceCustomerId,
    },
    range: "30d" as const,
  }
}

describe("getWorkspaceBillingOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("assembles access, wallet, and usage scoped to the billing project", async () => {
    const { deps } = createDeps()
    getCustomerCurrentAccessMock.mockResolvedValue(Ok(createAccess()))
    getCustomerWalletMock.mockResolvedValue(Ok(createWallet()))
    getUsageDashboardMock.mockResolvedValue(
      Ok({
        summary: { featureCount: 2, totalLatestUsage: 10, spending: [] },
        features: [],
        timeseries: [],
        topConsumers: [],
        freshness: { generatedAt: now, dataFrom: now - 1000, dataTo: now },
      })
    )

    const result = await getWorkspaceBillingOverview(deps as never, createInput())

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      customerId: "cus_workspace",
      billingProjectId: "proj_billing",
      paymentProvider: "stripe",
    })
    expect(result.val?.usage.summary.featureCount).toBe(2)
    expect(getCustomerCurrentAccessMock).toHaveBeenCalledWith(
      expect.anything(),
      { projectId: "proj_billing", customerId: "cus_workspace" }
    )
    expect(getCustomerWalletMock).toHaveBeenCalledWith(
      expect.anything(),
      { projectId: "proj_billing", customerId: "cus_workspace" }
    )
    expect(getUsageDashboardMock).toHaveBeenCalledWith(
      expect.anything(),
      { projectId: "proj_billing", customerId: "cus_workspace", range: "30d" }
    )
  })

  it("rejects when the workspace has no billing customer id", async () => {
    const { deps } = createDeps()

    const result = await getWorkspaceBillingOverview(deps as never, createInput(null))

    expect(result.err).toBeInstanceOf(GetWorkspaceBillingOverviewError)
    expect((result.err as GetWorkspaceBillingOverviewError).code).toBe(
      "WORKSPACE_BILLING_CUSTOMER_ID_MISSING"
    )
    expect(getCustomerCurrentAccessMock).not.toHaveBeenCalled()
  })

  it("rejects when the billing customer cannot be found", async () => {
    const { deps } = createDeps({ customer: null })

    const result = await getWorkspaceBillingOverview(deps as never, createInput())

    expect(result.err).toBeInstanceOf(GetWorkspaceBillingOverviewError)
    expect((result.err as GetWorkspaceBillingOverviewError).code).toBe(
      "WORKSPACE_BILLING_CUSTOMER_NOT_FOUND"
    )
  })

  it("rejects when the customer has no active billing access", async () => {
    const { deps } = createDeps()
    getCustomerCurrentAccessMock.mockResolvedValue(Ok(null))
    getCustomerWalletMock.mockResolvedValue(Ok(createWallet()))
    getUsageDashboardMock.mockResolvedValue(Ok(undefined))

    const result = await getWorkspaceBillingOverview(deps as never, createInput())

    expect(result.err).toBeInstanceOf(GetWorkspaceBillingOverviewError)
    expect((result.err as GetWorkspaceBillingOverviewError).code).toBe(
      "WORKSPACE_BILLING_ACCESS_NOT_FOUND"
    )
  })

  it("rejects when the customer has no wallet", async () => {
    const { deps } = createDeps()
    getCustomerCurrentAccessMock.mockResolvedValue(Ok(createAccess()))
    getCustomerWalletMock.mockResolvedValue(Ok(null))
    getUsageDashboardMock.mockResolvedValue(Ok(undefined))

    const result = await getWorkspaceBillingOverview(deps as never, createInput())

    expect(result.err).toBeInstanceOf(GetWorkspaceBillingOverviewError)
    expect((result.err as GetWorkspaceBillingOverviewError).code).toBe(
      "WORKSPACE_BILLING_WALLET_NOT_FOUND"
    )
  })

  it("degrades to an empty usage dashboard when usage fails, without failing the page", async () => {
    const { deps, logger } = createDeps()
    getCustomerCurrentAccessMock.mockResolvedValue(Ok(createAccess()))
    getCustomerWalletMock.mockResolvedValue(Ok(createWallet()))
    getUsageDashboardMock.mockResolvedValue(
      Err(new FetchError({ message: "tinybird unavailable", retry: false }))
    )

    const result = await getWorkspaceBillingOverview(deps as never, createInput())

    expect(result.err).toBeUndefined()
    expect(result.val?.usage.summary.featureCount).toBe(0)
    expect(logger.error).toHaveBeenCalled()
  })
})
