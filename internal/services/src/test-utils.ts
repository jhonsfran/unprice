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
    meterConfig: {
      eventId: "event_test_feature",
      eventSlug: "test-feature",
      aggregationMethod: "sum",
      aggregationField: "value",
    },
    mergingPolicy: "sum",
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    isCurrent: true,
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
    customerEntitlementId: "ce_123",
    type: "subscription",
    priority: 10,
    allowanceUnits: 100,
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    metadata: {},
    createdAtM: now,
    updatedAtM: now,
  }

  return { ...defaults, ...overrides }
}
