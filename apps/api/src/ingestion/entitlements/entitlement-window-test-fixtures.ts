export const BASE_NOW = Date.UTC(2026, 2, 19, 12, 0, 0)

const DEFAULT_METER_CONFIG = {
  aggregationField: "amount",
  aggregationMethod: "sum" as const,
  eventId: "meter_123",
  eventSlug: "tokens_used",
}

const DEFAULT_PRICE_CONFIG = {
  usageMode: "unit" as const,
  price: {
    dinero: {
      amount: 100,
      currency: { code: "USD", base: 10, exponent: 2 },
      scale: 2,
    },
    displayAmount: "1.00",
  },
}

export function createGrantSnapshot(overrides: Record<string, unknown> = {}) {
  const amount =
    typeof overrides.allowanceUnits === "number"
      ? overrides.allowanceUnits
      : typeof overrides.amount === "number"
        ? overrides.amount
        : null

  return {
    allowanceUnits: amount,
    amount,
    cadenceEffectiveAt: BASE_NOW - 60_000,
    cadenceExpiresAt: BASE_NOW + 60_000,
    currencyCode: "USD",
    effectiveAt: BASE_NOW - 60_000,
    expiresAt: BASE_NOW + 60_000,
    grantId: "grant_123",
    priority: 10,
    resetConfig: null,
    ...overrides,
  }
}

export function createApplyInput(overrides: Record<string, unknown> = {}) {
  const projectId = (overrides.projectId as string | undefined) ?? "proj_123"
  const customerId = (overrides.customerId as string | undefined) ?? "cus_123"
  const customerEntitlementId = (overrides.customerEntitlementId as string | undefined) ?? "ce_123"
  const periodStartAt =
    typeof overrides.periodStartAt === "number" ? overrides.periodStartAt : BASE_NOW - 60_000
  const periodEndAt =
    typeof overrides.periodEndAt === "number" ? overrides.periodEndAt : BASE_NOW + 60_000
  const resetConfig = (overrides.resetConfig as Record<string, unknown> | null | undefined) ?? null
  const currencyCode = typeof overrides.currency === "string" ? overrides.currency : "USD"
  const limit = typeof overrides.limit === "number" ? overrides.limit : null
  const grantSnapshots = (overrides.grants as
    | ReturnType<typeof createGrantSnapshot>[]
    | undefined) ?? [
    createGrantSnapshot({
      amount: limit,
      cadenceEffectiveAt: periodStartAt,
      cadenceExpiresAt: periodEndAt,
      currencyCode,
      effectiveAt: periodStartAt,
      expiresAt: periodEndAt,
      resetConfig,
    }),
  ]
  const subscriptionItemId =
    typeof overrides.subscriptionItemId === "string" ? overrides.subscriptionItemId : "item_123"
  const featurePlanVersionId =
    typeof overrides.featurePlanVersionId === "string" ? overrides.featurePlanVersionId : "fpv_123"
  const meterConfig =
    (overrides.meterConfig as typeof DEFAULT_METER_CONFIG | undefined) ?? DEFAULT_METER_CONFIG
  const priceConfig =
    (overrides.priceConfig as typeof DEFAULT_PRICE_CONFIG | undefined) ?? DEFAULT_PRICE_CONFIG
  const eventOverrides = (overrides.event as Record<string, unknown> | undefined) ?? {}

  const entitlement = {
    billingPeriods: [
      {
        billingPeriodId: "bp_123",
        cycleEndAt: periodEndAt,
        cycleStartAt: periodStartAt,
        featurePlanVersionItemId: subscriptionItemId,
        statementKey: "stmt_123",
      },
    ],
    creditLinePolicy:
      typeof overrides.creditLinePolicy === "string" ? overrides.creditLinePolicy : "uncapped",
    customerEntitlementId,
    customerId,
    effectiveAt: periodStartAt,
    expiresAt: periodEndAt,
    featureConfig: priceConfig,
    featurePlanVersionId,
    featureSlug: (overrides.featureSlug as string | undefined) ?? "api_calls",
    featureType: "usage",
    meterConfig,
    overageStrategy:
      typeof overrides.overageStrategy === "string" ? overrides.overageStrategy : "none",
    projectId,
    resetConfig,
    subscriptionItemId,
  }

  return {
    customerId,
    entitlement,
    enforceLimit: (overrides.enforceLimit as boolean | undefined) ?? false,
    event: {
      id: "evt_123",
      properties: { amount: 1 },
      source: {
        workspaceId: "ws_123",
        environment: "test",
        apiKeyId: "key_123",
        sourceType: "api_key",
        sourceId: "key_123",
        sourceName: null,
      },
      slug: "tokens_used",
      timestamp: BASE_NOW,
      ...eventOverrides,
    },
    idempotencyKey: (overrides.idempotencyKey as string | undefined) ?? "idem_123",
    now: (overrides.now as number | undefined) ?? BASE_NOW,
    projectId,
    grants: grantSnapshots.map((grant) => ({
      allowanceUnits:
        typeof grant.allowanceUnits === "number"
          ? grant.allowanceUnits
          : typeof grant.amount === "number"
            ? grant.amount
            : null,
      cadenceEffectiveAt: Number(grant.cadenceEffectiveAt),
      cadenceExpiresAt: grant.cadenceExpiresAt != null ? Number(grant.cadenceExpiresAt) : null,
      currencyCode: String(grant.currencyCode ?? currencyCode),
      effectiveAt: Number(grant.effectiveAt),
      expiresAt: grant.expiresAt != null ? Number(grant.expiresAt) : null,
      grantId: String(grant.grantId),
      priority: Number(grant.priority),
      resetConfig: grant.resetConfig ?? resetConfig,
    })),
  }
}
