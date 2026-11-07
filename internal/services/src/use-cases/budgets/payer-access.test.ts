import type { CustomerEntitlementExtended } from "@unprice/db/validators"
import { FetchError, Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { meterPayerUsage } from "./meter-payer-usage"
import { checkPayerAccess } from "./payer-access"
import { DEC, NOV, PROJECT_ID, image, payerHarness } from "./payer-budget.fixture"

const now = NOV + 3_600_000

function staticEntitlement(
  slug: string,
  featureType: "flat" | "tier" | "usage",
  allowance: number
) {
  return {
    featurePlanVersion: { featureType, limit: null, feature: { slug } },
    grants: [{ allowanceUnits: allowance }],
  } as unknown as CustomerEntitlementExtended
}

function access(entitlements: CustomerEntitlementExtended[] = []) {
  const h = payerHarness()
  const getCustomerEntitlementsForCustomer = vi.fn().mockResolvedValue(Ok(entitlements))
  const deps = { budgets: h.budgets, entitlements: { getCustomerEntitlementsForCustomer } }
  const check = (featureSlug: string, customerId = "cus_a") =>
    checkPayerAccess(deps, { projectId: PROJECT_ID, customerId, featureSlug, now })
  return { h, check, getCustomerEntitlementsForCustomer }
}

describe("checkPayerAccess", () => {
  it("answers a metered feature from the payer budget's quantity limit", async () => {
    const { h, check, getCustomerEntitlementsForCustomer } = access()
    await h.createPayer("cus_a", { imagesLimit: 3 })
    await meterPayerUsage(h.deps, {
      verb: "charge",
      receivedAt: now,
      events: [
        { projectId: PROJECT_ID, customerId: "cus_a", idempotencyKey: "c1", ...image("512") },
      ],
    })

    const result = await check("images")

    expect(result.val).toEqual({
      featureSlug: "images",
      allowed: true,
      metered: true,
      usage: 1,
      limit: 3,
      quotaWindow: { periodKey: "images:month", startAt: NOV, endAt: DEC },
    })
    expect(getCustomerEntitlementsForCustomer).not.toHaveBeenCalled()
  })

  it("denies a metered feature whose hard limit has no room", async () => {
    const { h, check } = access()
    await h.createPayer("cus_a", { imagesLimit: 1 })
    await meterPayerUsage(h.deps, {
      verb: "charge",
      receivedAt: now,
      events: [
        { projectId: PROJECT_ID, customerId: "cus_a", idempotencyKey: "c1", ...image("512") },
      ],
    })

    const result = await check("images")

    expect(result.val).toMatchObject({
      allowed: false,
      rejectionReason: "LIMIT_EXCEEDED",
      usage: 1,
      limit: 1,
    })
  })

  it("allows a metered feature without a limit and reports no usage window", async () => {
    const { h, check } = access()
    await h.createPayer("cus_a")

    expect((await check("images")).val).toEqual({
      featureSlug: "images",
      allowed: true,
      metered: true,
      limit: null,
      quotaWindow: null,
    })
  })

  it("answers a feature the budget does not meter from the customer's entitlements", async () => {
    const { h, check } = access([
      staticEntitlement("sso", "flat", 1),
      staticEntitlement("seats", "tier", 5),
      staticEntitlement("tokens", "usage", 100),
    ])
    await h.createPayer("cus_a")

    expect((await check("seats")).val).toEqual({
      featureSlug: "seats",
      allowed: true,
      metered: false,
      limit: 5,
      quotaWindow: null,
    })
    expect((await check("sso")).val).toMatchObject({ allowed: true, metered: false })
    // A usage feature only the payer budget can answer for.
    expect((await check("tokens")).val).toMatchObject({
      allowed: false,
      rejectionReason: "NO_ENTITLEMENT",
    })
    expect((await check("missing")).val).toMatchObject({
      allowed: false,
      rejectionReason: "NO_ENTITLEMENT",
    })
  })

  it("answers static features for a customer that has no payer budget yet", async () => {
    const { check } = access([staticEntitlement("sso", "flat", 1)])

    expect((await check("sso", "cus_new")).val).toMatchObject({ allowed: true, metered: false })
  })

  it("returns the entitlement query failure", async () => {
    const { check, getCustomerEntitlementsForCustomer } = access()
    const failure = new FetchError({ message: "database unavailable", retry: true })
    getCustomerEntitlementsForCustomer.mockResolvedValue({ err: failure })

    expect((await check("sso")).err).toBe(failure)
  })
})
