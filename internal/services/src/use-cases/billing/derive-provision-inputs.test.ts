import type { Database } from "@unprice/db"
import { rateRowSchema } from "@unprice/db/validators"
import { fromLedgerAmount, toLedgerMinor } from "@unprice/money"
import { describe, expect, it, vi } from "vitest"
import {
  deriveActivationInputsFromPlan,
  derivePeriodUsageAllowanceAmount,
} from "./derive-provision-inputs"

const ledger = (amount: string) => toLedgerMinor(fromLedgerAmount(amount, "USD"))

const projectId = "prj_abc"
const subscriptionId = "sub_abc"

function usageUnitFeature({
  limit,
  included = null,
}: { limit: number | null; included?: string | null }) {
  return { featureType: "usage" as const, limit, included, feature: { slug: "api" } }
}

/** The plan card's row for `api`, in its stored (wire) form. */
function wireRow(rate: string) {
  return {
    id: "rr_api",
    rateCardId: "rc_plan",
    featureSlug: "api",
    match: {},
    price: { type: "unit", components: [{ property: null, rate, per: 1 }] },
    cost: null,
    effectiveFrom: 0,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
  }
}

const rows = (rate: string) => [rateRowSchema.parse(wireRow(rate))]

function createDb(phase: {
  creditLinePolicy: "capped" | "uncapped"
  creditLineAmount: number | null
  planVersion: {
    metadata?: { includedCreditAmount?: number } | null
    planFeatures: Array<ReturnType<typeof usageUnitFeature>>
  }
}) {
  const findFirst = vi.fn(async (_query?: unknown) => ({
    id: subscriptionId,
    projectId,
    customer: { id: "cus_abc", defaultCurrency: "USD" },
    phases: [{ ...phase, planVersion: { id: "pv_abc", currency: "USD", ...phase.planVersion } }],
  }))

  const db = {
    query: {
      subscriptions: {
        findFirst,
      },
      planVersionRateCards: {
        findFirst: vi.fn(async () => ({ card: { rows: [wireRow("0.5")] } })),
      },
    },
  } as unknown as Database

  return { db, findFirst }
}

describe("derivePeriodUsageAllowanceAmount", () => {
  it("uses the explicit period usage allowance when present", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        creditLinePolicy: "capped",
        creditLineAmount: ledger("120"),
        planVersion: {
          planFeatures: [usageUnitFeature({ limit: 10 })],
          rows: rows("0.5"),
        },
      })
    ).toBe(ledger("120"))
  })

  it("derives capped allowance from finite priced usage limits", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        creditLinePolicy: "capped",
        creditLineAmount: null,
        planVersion: {
          planFeatures: [usageUnitFeature({ limit: 10 })],
          rows: rows("0.5"),
        },
      })
    ).toBe(ledger("5"))
  })

  it("prices only the units past the feature's included allowance", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        creditLinePolicy: "capped",
        creditLineAmount: null,
        planVersion: {
          planFeatures: [usageUnitFeature({ limit: 10, included: "4" })],
          rows: rows("0.5"),
        },
      })
    ).toBe(ledger("3"))
  })

  it("does not infer credit for unlimited paid usage", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        creditLinePolicy: "capped",
        creditLineAmount: null,
        planVersion: {
          planFeatures: [usageUnitFeature({ limit: null })],
          rows: rows("0.5"),
        },
      })
    ).toBe(0)
  })

  it("treats zero as an explicit capped amount", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        creditLinePolicy: "capped",
        creditLineAmount: 0,
        planVersion: {
          planFeatures: [usageUnitFeature({ limit: 10 })],
          rows: rows("0.5"),
        },
      })
    ).toBe(0)
  })

  it("does not mint wallet credit for uncapped usage", () => {
    expect(
      derivePeriodUsageAllowanceAmount({
        creditLinePolicy: "uncapped",
        creditLineAmount: ledger("120"),
        planVersion: {
          planFeatures: [usageUnitFeature({ limit: 10 })],
          rows: rows("0.5"),
        },
      })
    ).toBe(0)
  })
})

describe("deriveActivationInputsFromPlan", () => {
  it("issues a credit_line grant for the derived period usage allowance", async () => {
    const { db } = createDb({
      creditLinePolicy: "capped",
      creditLineAmount: null,
      planVersion: {
        planFeatures: [usageUnitFeature({ limit: 10 })],
      },
    })

    const result = await deriveActivationInputsFromPlan(db, { subscriptionId, projectId })

    expect(result?.grants).toEqual([
      {
        amount: ledger("5"),
        source: "credit_line",
        reason: "Period usage allowance",
      },
    ])
  })

  it("returns the uncapped policy without issuing a credit_line grant", async () => {
    const { db } = createDb({
      creditLinePolicy: "uncapped",
      creditLineAmount: null,
      planVersion: {
        planFeatures: [usageUnitFeature({ limit: 10 })],
      },
    })

    const result = await deriveActivationInputsFromPlan(db, { subscriptionId, projectId })

    expect(result).toEqual({
      creditLinePolicy: "uncapped",
      grants: [],
    })
  })

  it("issues a plan_included grant before the credit_line grant when the plan includes credits", async () => {
    const { db } = createDb({
      creditLinePolicy: "capped",
      creditLineAmount: ledger("10"),
      planVersion: {
        metadata: { includedCreditAmount: ledger("5") },
        planFeatures: [],
      },
    })

    const result = await deriveActivationInputsFromPlan(db, { subscriptionId, projectId })

    expect(result?.grants).toEqual([
      {
        amount: ledger("5"),
        source: "plan_included",
        reason: "Plan included credits",
      },
      {
        amount: ledger("10"),
        source: "credit_line",
        reason: "Period usage allowance",
      },
    ])
  })

  it("issues no plan_included grant when the plan has no included credit config", async () => {
    const { db } = createDb({
      creditLinePolicy: "capped",
      creditLineAmount: ledger("10"),
      planVersion: {
        metadata: null,
        planFeatures: [],
      },
    })

    const result = await deriveActivationInputsFromPlan(db, { subscriptionId, projectId })

    expect(result?.grants.map((grant) => grant.source)).toEqual(["credit_line"])
  })

  it("filters phases by the provided phaseId", async () => {
    const { db, findFirst } = createDb({
      creditLinePolicy: "capped",
      creditLineAmount: ledger("10"),
      planVersion: {
        metadata: null,
        planFeatures: [],
      },
    })

    await deriveActivationInputsFromPlan(db, { subscriptionId, projectId, phaseId: "phase_123" })
    await deriveActivationInputsFromPlan(db, { subscriptionId, projectId })

    const withPhaseId = findFirst.mock.calls[0]?.[0] as {
      with: { phases: { where?: unknown } }
    }
    const withoutPhaseId = findFirst.mock.calls[1]?.[0] as {
      with: { phases: { where?: unknown } }
    }

    expect(typeof withPhaseId.with.phases.where).toBe("function")
    expect(withoutPhaseId.with.phases.where).toBeUndefined()
  })
})
