import type { Grant } from "@unprice/db/validators"

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
