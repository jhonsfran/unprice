import { describe, expect, it, vi } from "vitest"
import { route as accessUpdateRoute } from "~/routes/access/updateACLV1"
import { route as analyticsChargesExplainRoute } from "~/routes/analytics/explainChargeV1"
import { route as analyticsUsageForecastRoute } from "~/routes/analytics/forecastUsageV1"
import { route as ingestionEventsStatusRoute } from "~/routes/analytics/getIngestionStatusV1"
import { route as analyticsUsageRoute } from "~/routes/analytics/getUsageV1"
import { route as billingReservationsFlushForInvoicingRoute } from "~/routes/billing/flushReservationsForInvoicingV1"
import { route as customersSignUpRoute } from "~/routes/customers/signUpV1"
import { route as entitlementWindowsStatusRoute } from "~/routes/entitlements/getEntitlementWindowStatusV1"
import { route as accessEntitlementsListRoute } from "~/routes/entitlements/getEntitlementsV1"
import { route as accessCheckRoute } from "~/routes/entitlements/verifyV1"
import { route as usageConsumeRoute } from "~/routes/events/ingestEventsSyncV1"
import { route as usageRecordRoute } from "~/routes/events/ingestEventsV1"
import { route as ingestionEventsReplayRoute } from "~/routes/events/replayIngestionEventsV1"
import { route as featuresListRoute } from "~/routes/features/getFeaturesV1"
import { route as invoicesGetRoute } from "~/routes/invoices/getInvoiceV1"
import { route as paymentMethodsCreateRoute } from "~/routes/payments/methods/createPaymentMethodV1"
import { route as paymentMethodsListRoute } from "~/routes/payments/methods/listPaymentMethodsV1"
import { route as paymentProviderCallbacksSetupRoute } from "~/routes/payments/providers/providerSetupV1"
import { route as paymentProviderCallbacksSignUpRoute } from "~/routes/payments/providers/providerSignUpV1"
import { route as paymentProviderCallbacksStripeConnectWebhookRoute } from "~/routes/payments/providers/providerStripeConnectWebhookV1"
import { route as paymentProviderCallbacksWebhookRoute } from "~/routes/payments/providers/providerWebhookV1"
import { route as planVersionsGetRoute } from "~/routes/plans/getPlanVersionV1"
import { route as planVersionsListRoute } from "~/routes/plans/listPlanVersionsV1"
import { route as runsConsumeRoute } from "~/routes/runs/applyRunSyncEventV1"
import { route as runsEndRoute } from "~/routes/runs/endRunV1"
import { route as runsGetRoute } from "~/routes/runs/getRunV1"
import { route as runsStartRoute } from "~/routes/runs/startRunV1"
import { route as subscriptionsGetRoute } from "~/routes/subscriptions/getSubscriptionV1"
import {
  walletBalanceRoute,
  walletCreditBalanceRoute,
  route as walletRoute,
} from "~/routes/wallet/getWalletV1"
import type { EndpointContract } from "./endpoint-contract"
import { validateEndpointContract } from "./endpoint-contract"

vi.mock("cloudflare:workers", () => ({ env: {} }))

type RouteUnderTest = {
  method: string
  path: string
  operationId: string
  tags: readonly string[]
  "x-unprice"?: EndpointContract
}

const routes = [
  accessUpdateRoute,
  accessCheckRoute,
  accessEntitlementsListRoute,
  usageRecordRoute,
  usageConsumeRoute,
  runsStartRoute,
  runsConsumeRoute,
  runsEndRoute,
  runsGetRoute,
  customersSignUpRoute,
  featuresListRoute,
  planVersionsListRoute,
  planVersionsGetRoute,
  subscriptionsGetRoute,
  paymentMethodsListRoute,
  paymentMethodsCreateRoute,
  walletBalanceRoute,
  walletCreditBalanceRoute,
  walletRoute,
  invoicesGetRoute,
  analyticsUsageRoute,
  analyticsChargesExplainRoute,
  analyticsUsageForecastRoute,
  ingestionEventsStatusRoute,
  ingestionEventsReplayRoute,
  entitlementWindowsStatusRoute,
  billingReservationsFlushForInvoicingRoute,
  paymentProviderCallbacksSignUpRoute,
  paymentProviderCallbacksSetupRoute,
  paymentProviderCallbacksWebhookRoute,
  paymentProviderCallbacksStripeConnectWebhookRoute,
].map((route) => route as RouteUnderTest)

const expectedRoutes = new Map<string, string>([
  ["access.update", "POST /v1/access/update"],
  ["access.check", "POST /v1/access/check"],
  ["access.entitlements.list", "POST /v1/access/entitlements/list"],
  ["usage.record", "POST /v1/usage/record"],
  ["usage.consume", "POST /v1/usage/consume"],
  ["runs.start", "POST /v1/runs/start"],
  ["runs.consume", "POST /v1/runs/consume/{runId}"],
  ["runs.end", "POST /v1/runs/end/{runId}"],
  ["runs.get", "GET /v1/runs/get/{runId}"],
  ["customers.signUp", "POST /v1/customers/sign-up"],
  ["features.list", "GET /v1/features/list"],
  ["planVersions.list", "POST /v1/plan-versions/list"],
  ["planVersions.get", "GET /v1/plan-versions/get/{planVersionId}"],
  ["subscriptions.get", "POST /v1/subscriptions/get"],
  ["paymentMethods.list", "POST /v1/payment-methods/list"],
  ["paymentMethods.create", "POST /v1/payment-methods/create"],
  ["wallet.balance", "GET /v1/wallet/balance"],
  ["walletCredits.balance", "GET /v1/wallet-credits/balance/{walletId}"],
  ["wallet.internalGet", "GET /v1/internal/wallet/get"],
  ["invoices.get", "GET /v1/invoices/get/{invoiceId}"],
  ["analytics.usage.get", "POST /v1/analytics/usage/get"],
  ["analytics.charges.explain", "POST /v1/analytics/charges/explain"],
  ["analytics.usage.forecast", "POST /v1/analytics/usage/forecast"],
  ["ingestionEvents.status", "POST /v1/ingestion-events/status"],
  ["ingestionEvents.replay", "POST /v1/ingestion-events/replay"],
  ["entitlementWindows.status", "GET /v1/internal/entitlement-windows/status"],
  [
    "billingReservations.flushForInvoicing",
    "POST /v1/internal/billing-reservations/flush-for-invoicing",
  ],
  [
    "paymentProviderCallbacks.signUp",
    "GET /v1/payment-provider-callbacks/{provider}/sign-up/{sessionId}/{projectId}",
  ],
  [
    "paymentProviderCallbacks.setup",
    "GET /v1/payment-provider-callbacks/{provider}/setup/{sessionId}/{projectId}",
  ],
  [
    "paymentProviderCallbacks.webhook",
    "POST /v1/payment-provider-callbacks/{provider}/webhook/{projectId}",
  ],
  [
    "paymentProviderCallbacks.stripeConnectWebhook",
    "POST /v1/payment-provider-callbacks/stripe-connect/webhook",
  ],
])

const expectedSdkPublicOperations = [
  "access.update",
  "access.check",
  "access.entitlements.list",
  "usage.record",
  "usage.consume",
  "runs.start",
  "runs.consume",
  "runs.end",
  "runs.get",
  "customers.signUp",
  "features.list",
  "planVersions.list",
  "planVersions.get",
  "subscriptions.get",
  "paymentMethods.list",
  "paymentMethods.create",
  "wallet.balance",
  "walletCredits.balance",
  "invoices.get",
  "analytics.usage.get",
  "analytics.charges.explain",
  "analytics.usage.forecast",
  "ingestionEvents.status",
  "ingestionEvents.replay",
].sort()

function routeKey(route: RouteUnderTest): string {
  return `${route.method.toUpperCase()} ${route.path}`
}

describe("public operation contracts", () => {
  it("declares x-unprice metadata on every route", () => {
    expect(
      routes.map((route) => ({
        operationId: route.operationId,
        contract: route["x-unprice"],
      }))
    ).toEqual(
      routes.map((route) => ({
        operationId: route.operationId,
        contract: expect.any(Object),
      }))
    )
  })

  it("does not duplicate operation IDs", () => {
    const operationIds = routes.map((route) => route.operationId)
    expect(new Set(operationIds).size).toBe(operationIds.length)
  })

  it("validates every endpoint contract", () => {
    for (const route of routes) {
      const contract = route["x-unprice"]
      expect(contract).toBeDefined()

      if (!contract) {
        continue
      }

      validateEndpointContract(route, contract)
    }
  })

  it("matches the canonical public and private API surface", () => {
    expect(new Set(routes.map((route) => route.operationId))).toEqual(
      new Set(expectedRoutes.keys())
    )

    for (const route of routes) {
      expect(routeKey(route)).toBe(expectedRoutes.get(route.operationId))
    }
  })

  it("exposes exactly the intended public SDK operations", () => {
    const sdkPublicOperations = routes
      .filter((route) => route["x-unprice"]?.audience === "public")
      .filter((route) => route["x-unprice"]?.sdk !== false)
      .map((route) => route.operationId)
      .sort()

    expect(sdkPublicOperations).toEqual(expectedSdkPublicOperations)
  })

  it("declares run start idempotency on the request body key", () => {
    expect(runsStartRoute["x-unprice"].idempotency).toEqual({
      required: true,
      location: "body",
      field: "idempotencyKey",
    })
  })

  it("does not expose non-public routes in the SDK", () => {
    for (const route of routes.filter(
      (candidate) => candidate["x-unprice"]?.audience !== "public"
    )) {
      expect(route["x-unprice"]?.sdk).toBe(false)
    }
  })
})
