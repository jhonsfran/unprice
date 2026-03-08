import type { EntitlementState, Grant } from "@unprice/db/validators"

/**
 * Creates a virtual clock for deterministic time-based testing.
 */
export const createClock = (initialTime: number) => {
  let currentTime = initialTime
  return {
    now: () => currentTime,
    advanceBy: (ms: number) => {
      currentTime += ms
    },
    set: (time: number) => {
      currentTime = time
    },
  }
}

/**
 * Factory for creating mock EntitlementState objects.
 */
export const createMockEntitlementState = (
  overrides: Partial<EntitlementState> = {},
  now = Date.now()
): EntitlementState => {
  const defaults: EntitlementState = {
    id: "ent_123",
    projectId: "proj_123",
    customerId: "cust_123",
    featureSlug: "test-feature",
    featureType: "usage",
    unitOfMeasure: "units",
    limit: 100,
    aggregationMethod: "sum",
    mergingPolicy: "sum",
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    nextRevalidateAt: now + 300000,
    computedAt: now,
    version: "v1",
    grants: [],
    resetConfig: null,
    metadata: {
      overageStrategy: "none",
      realtime: false,
      notifyUsageThreshold: 90,
      blockCustomer: false,
      hidden: false,
    },
    meter: {
      usage: "0",
      snapshotUsage: "0",
      lastReconciledId: "rec_initial",
      lastUpdated: now,
      lastCycleStart: now - 10000,
    },
    createdAtM: now,
    updatedAtM: now,
  }

  // Deep merge meter if provided
  if (overrides.meter) {
    overrides.meter = { ...defaults.meter, ...overrides.meter }
  }

  return { ...defaults, ...overrides }
}

/**
 * Factory for creating mock Grant objects.
 */
export const createMockGrant = (overrides: Partial<Grant> = {}, now = Date.now()): Grant => {
  const defaults: Grant = {
    id: "grant_123",
    projectId: "proj_123",
    subjectId: "cust_123",
    subjectType: "customer",
    type: "subscription",
    name: "Standard Grant",
    featurePlanVersionId: "fpv_123",
    priority: 10,
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    autoRenew: true,
    deleted: false,
    deletedAt: null,
    limit: 100,
    overageStrategy: "none",
    units: null,
    anchor: 1,
    metadata: {},
    createdAtM: now,
    updatedAtM: now,
  }

  return { ...defaults, ...overrides }
}
