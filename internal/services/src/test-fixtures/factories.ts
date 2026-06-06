import type {
  BillingPeriod,
  Customer,
  Subscription,
  SubscriptionInvoice,
} from "@unprice/db/validators"
import { z } from "zod"

export const TEST_PROJECT_ID = "proj_test"
export const TEST_WORKSPACE_ID = "workspace_test"
export const TEST_CUSTOMER_ID = "cus_test"
export const TEST_SUBSCRIPTION_ID = "sub_test"
export const TEST_SUBSCRIPTION_PHASE_ID = "phase_test"
export const TEST_SUBSCRIPTION_ITEM_ID = "item_test"

export function createDeterministicIdGenerator() {
  const counters = new Map<string, number>()

  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1
    counters.set(prefix, next)
    return `${prefix}_${String(next).padStart(4, "0")}`
  }
}

let deterministicIdGenerator = createDeterministicIdGenerator()

export function resetDeterministicIds() {
  deterministicIdGenerator = createDeterministicIdGenerator()
}

export function deterministicId(prefix: string) {
  return deterministicIdGenerator(prefix)
}

export const testUsageEventSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  projectId: z.string().min(1),
  customerId: z.string().min(1),
  featureSlug: z.string().min(1),
  eventSlug: z.string().min(1),
  quantity: z.number(),
  occurredAt: z.number().int(),
  properties: z.record(z.unknown()).default({}),
})

export type TestUsageEvent = z.infer<typeof testUsageEventSchema>

export function buildCustomer(overrides: Partial<Customer> = {}): Customer {
  const now = Date.parse("2026-01-01T00:00:00.000Z")

  return {
    id: TEST_CUSTOMER_ID,
    projectId: TEST_PROJECT_ID,
    email: "billing-test-customer@example.com",
    name: "Billing Test Customer",
    description: null,
    externalId: "billing-test-customer",
    metadata: {},
    active: true,
    isMain: false,
    defaultCurrency: "EUR",
    timezone: "UTC",
    createdAtM: now,
    updatedAtM: now,
    ...overrides,
  }
}

export function buildSubscription(overrides: Partial<Subscription> = {}): Subscription {
  const now = Date.parse("2026-01-01T00:00:00.000Z")
  const cycleEnd = Date.parse("2026-02-01T00:00:00.000Z")

  return {
    id: TEST_SUBSCRIPTION_ID,
    projectId: TEST_PROJECT_ID,
    customerId: TEST_CUSTOMER_ID,
    status: "active",
    active: true,
    planSlug: "monthly-arrear",
    currentCycleStartAt: now,
    currentCycleEndAt: cycleEnd,
    renewAt: cycleEnd,
    endAt: null,
    timezone: "UTC",
    metadata: null,
    createdAtM: now,
    updatedAtM: now,
    ...overrides,
  }
}

export function buildUsageEvent(overrides: Partial<TestUsageEvent> = {}): TestUsageEvent {
  const occurredAt = Date.parse("2026-01-15T12:00:00.000Z")

  return testUsageEventSchema.parse({
    id: deterministicId("evt"),
    idempotencyKey: deterministicId("idem"),
    projectId: TEST_PROJECT_ID,
    customerId: TEST_CUSTOMER_ID,
    featureSlug: "api_calls",
    eventSlug: "usage.recorded",
    quantity: 1,
    occurredAt,
    properties: { amount: 1 },
    ...overrides,
  })
}

export function buildBillingPeriod(overrides: Partial<BillingPeriod> = {}): BillingPeriod {
  const now = Date.parse("2026-01-01T00:00:00.000Z")
  const cycleEnd = Date.parse("2026-02-01T00:00:00.000Z")

  return {
    id: deterministicId("bp"),
    projectId: TEST_PROJECT_ID,
    subscriptionId: TEST_SUBSCRIPTION_ID,
    customerId: TEST_CUSTOMER_ID,
    subscriptionPhaseId: TEST_SUBSCRIPTION_PHASE_ID,
    subscriptionItemId: TEST_SUBSCRIPTION_ITEM_ID,
    status: "pending",
    type: "normal",
    cycleStartAt: now,
    cycleEndAt: cycleEnd,
    amountEstimate: null,
    reason: "normal",
    invoiceId: null,
    whenToBill: "pay_in_arrear",
    invoiceAt: cycleEnd,
    statementKey: "stmt_test_2026_01",
    createdAtM: now,
    updatedAtM: now,
    ...overrides,
  }
}

export function buildInvoice(overrides: Partial<SubscriptionInvoice> = {}): SubscriptionInvoice {
  const now = Date.parse("2026-02-01T00:00:00.000Z")

  return {
    id: deterministicId("inv"),
    projectId: TEST_PROJECT_ID,
    subscriptionId: TEST_SUBSCRIPTION_ID,
    customerId: TEST_CUSTOMER_ID,
    status: "draft",
    issueDate: null,
    requiredPaymentMethod: false,
    paymentMethodId: null,
    statementDateString: "February 1, 2026",
    statementKey: "stmt_test_2026_01",
    statementStartAt: Date.parse("2026-01-01T00:00:00.000Z"),
    statementEndAt: now,
    whenToBill: "pay_in_arrear",
    collectionMethod: "charge_automatically",
    paymentProvider: "sandbox",
    currency: "USD",
    sentAt: null,
    dueAt: now,
    paidAt: null,
    grossAmount: 0,
    amountDue: 0,
    amountPaid: 0,
    amountIncluded: 0,
    invoicePaymentProviderId: null,
    invoicePaymentProviderUrl: null,
    pastDueAt: Date.parse("2026-02-04T00:00:00.000Z"),
    metadata: null,
    createdAtM: now,
    updatedAtM: now,
    ...overrides,
  }
}
