import type { Database } from "@unprice/db"
import { rateRowSchema } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { UnPriceCustomerError } from "../../customers/errors"
import { publishPlanVersion } from "./publish"

function createLogger(): Logger {
  return {
    set: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    emit: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

/** The version's USD card: a $1 flat base fee, so a customer needs a payment method. */
function baseCard() {
  const row = rateRowSchema.parse({
    id: "rr_base",
    rateCardId: "rc_1",
    featureSlug: "base",
    match: {},
    price: { type: "flat", amount: "1" },
    cost: null,
    effectiveFrom: 0,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
  })
  return new Map([["pv_123", [{ currency: "USD", card: {}, rows: [row] }]]])
}

describe("publishPlanVersion", () => {
  it("logs payment provider validation failures before returning payment_provider_error", async () => {
    const logger = createLogger()
    const providerError = new UnPriceCustomerError({
      code: "PAYMENT_PROVIDER_CONFIG_NOT_FOUND",
      message: "Payment provider config not found or not active",
    })
    const getPaymentProvider = vi.fn().mockResolvedValue({ err: providerError })

    const db = {
      query: {
        versions: {
          findFirst: vi.fn().mockResolvedValue({
            id: "pv_123",
            projectId: "proj_123",
            planId: "plan_123",
            status: "draft",
            collectionMethod: "charge_automatically",
            currency: "USD",
            paymentProvider: "sandbox",
            planFeatures: [
              {
                id: "fpv_123",
                featureType: "flat",
                config: {},
                feature: { id: "feature_123", slug: "base" },
              },
            ],
            project: { id: "proj_123" },
            plan: { id: "plan_123" },
          }),
        },
      },
    } as unknown as Database

    const { val, err } = await publishPlanVersion(
      {
        services: {
          customers: {
            getPaymentProvider,
          },
          rateCards: { pricingForPlanVersions: vi.fn(async () => baseCard()) },
        } as unknown as Pick<ServiceContext, "customers" | "rateCards">,
        db,
        logger,
        userId: "usr_123",
      },
      {
        id: "pv_123",
        projectId: "proj_123",
        workspaceUnPriceCustomerId: "cus_123",
      }
    )

    expect(err).toBeUndefined()
    expect(val?.state).toBe("payment_provider_error")
    expect(logger.error).toHaveBeenCalledWith(
      "payment provider validation failed while publishing plan version",
      expect.objectContaining({
        context: "error validating payment provider for plan version publish",
        projectId: "proj_123",
        planVersionId: "pv_123",
        provider: "sandbox",
        paymentProvider: "sandbox",
        paymentProviderError: expect.objectContaining({
          type: "UnPriceCustomerError",
          message: "Payment provider config not found or not active",
        }),
        paymentProviderErrorCode: "PAYMENT_PROVIDER_CONFIG_NOT_FOUND",
      })
    )
  })

  describe("refuses a version that would ship free", () => {
    /** A USD draft with a flat `base` fee and a metered `api` feature. */
    function publishWith(pricing: Map<string, unknown[]>) {
      const db = {
        query: {
          versions: {
            findFirst: vi.fn().mockResolvedValue({
              id: "pv_123",
              projectId: "proj_123",
              planId: "plan_123",
              status: "draft",
              collectionMethod: "charge_automatically",
              currency: "USD",
              paymentProvider: "sandbox",
              planFeatures: [
                { id: "fpv_base", featureType: "flat", feature: { slug: "base" } },
                { id: "fpv_api", featureType: "usage", feature: { slug: "api" } },
              ],
            }),
          },
        },
        transaction: vi.fn(),
      } as unknown as Database
      const getPaymentProvider = vi.fn()

      const result = publishPlanVersion(
        {
          services: {
            customers: { getPaymentProvider },
            rateCards: { pricingForPlanVersions: vi.fn(async () => pricing) },
          } as unknown as Pick<ServiceContext, "customers" | "rateCards">,
          db,
          logger: createLogger(),
          userId: "usr_123",
        },
        { id: "pv_123", projectId: "proj_123", workspaceUnPriceCustomerId: "cus_123" }
      )
      return { result, db, getPaymentProvider }
    }

    it("without a card in the version's currency", async () => {
      const euros =
        baseCard()
          .get("pv_123")
          ?.map((card) => ({ ...card, currency: "EUR" })) ?? []
      const { result, db, getPaymentProvider } = publishWith(new Map([["pv_123", euros]]))

      expect((await result).val).toEqual({ state: "unpriced", reason: "no_card", featureSlugs: [] })
      expect(getPaymentProvider).not.toHaveBeenCalled()
      expect(db.transaction).not.toHaveBeenCalled()
    })

    it("when a feature has no current or scheduled row on the card", async () => {
      const { result, db } = publishWith(baseCard())

      expect((await result).val).toEqual({
        state: "unpriced",
        reason: "missing_rows",
        featureSlugs: ["api"],
      })
      expect(db.transaction).not.toHaveBeenCalled()
    })
  })

  it("refuses rows that break a rule for the version's features, read under the cards' lock", async () => {
    const modelRow = rateRowSchema.parse({
      id: "rr_api_model",
      rateCardId: "rc_1",
      featureSlug: "api",
      match: { model: "gpt-5" },
      price: { type: "unit", components: [{ property: "calls", rate: "0.01", per: 1 }] },
      cost: null,
      effectiveFrom: 0,
      effectiveTo: null,
      source: "manual",
      sourceRef: null,
    })
    const apiMeter = {
      eventId: "evt_api",
      eventSlug: "api",
      aggregationMethod: "sum",
      aggregationField: "calls",
    }
    const card = { id: "rc_1", unit: "money:USD", marginPolicy: { type: "manual" } }
    const pricing = new Map([["pv_123", [{ currency: "USD", card, rows: [modelRow] }]]])
    const writes: unknown[] = []
    const tx = {
      update: vi.fn(() => {
        writes.push("update")
        return { set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn() })) })) }
      }),
    }
    const db = {
      query: {
        versions: {
          findFirst: vi.fn().mockResolvedValue({
            id: "pv_123",
            projectId: "proj_123",
            planId: "plan_123",
            status: "draft",
            collectionMethod: "send_invoice",
            currency: "USD",
            paymentProvider: "sandbox",
            planFeatures: [
              {
                id: "fpv_api",
                featureType: "usage",
                meterConfig: apiMeter,
                feature: { slug: "api" },
              },
            ],
          }),
        },
      },
      transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    } as unknown as Database
    const lockPlanVersionCards = vi.fn(async () => ["rc_1"])
    const getEffectiveRows = vi.fn(async (_read: { cardIds: string[]; executor: unknown }) => [
      modelRow,
    ])

    const { val } = await publishPlanVersion(
      {
        services: {
          customers: { getPaymentProvider: vi.fn() },
          rateCards: {
            pricingForPlanVersions: vi.fn(async () => pricing),
            lockPlanVersionCards,
            getEffectiveRows,
          },
        } as unknown as Pick<ServiceContext, "customers" | "rateCards">,
        db,
        logger: createLogger(),
        userId: "usr_123",
      },
      { id: "pv_123", projectId: "proj_123", workspaceUnPriceCustomerId: "cus_123" }
    )

    expect(val).toEqual({
      state: "invalid_rows",
      violations: [
        { code: "UNKNOWN_DIMENSION", rowId: "rr_api_model", key: "model", feature: "api" },
      ],
    })
    expect(lockPlanVersionCards).toHaveBeenCalledWith("proj_123", "pv_123", tx)
    expect(getEffectiveRows.mock.calls[0]?.[0]).toMatchObject({ cardIds: ["rc_1"], executor: tx })
    expect(writes).toEqual([])
  })
})
