import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { dinero } from "dinero.js"
import * as dineroCurrencies from "dinero.js/currencies"
import { describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache"
import type { CustomerService } from "../customers/service"
import type { GrantsManager } from "../entitlements"
import type { LedgerGateway } from "../ledger"
import type { Metrics } from "../metrics"
import { UnPriceRatingError } from "../rating/errors"
import type { RatingService } from "../rating/service"
import { BillingService } from "./service"

describe("BillingService rating delegation", () => {
  const buildBillingService = (ratingService: RatingService) =>
    new BillingService({
      db: {} as Database,
      logger: {
        set: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      } as unknown as Logger,
      analytics: {} as Analytics,
      waitUntil: (promise: Promise<unknown>) => promise,
      cache: {} as Cache,
      metrics: {} as Metrics,
      customerService: {} as CustomerService,
      grantsManager: {} as GrantsManager,
      ratingService,
      ledgerService: {} as LedgerGateway,
    })

  it("delegates calculateFeaturePrice to RatingService.rateBillingPeriod", async () => {
    const usd = dineroCurrencies.USD
    const ratedCharge = {
      grantId: "grant_1",
      price: {
        unitPrice: {
          dinero: dinero({ amount: 100, currency: usd }),
          displayAmount: "$1",
        },
        subtotalPrice: {
          dinero: dinero({ amount: 200, currency: usd }),
          displayAmount: "$2",
        },
        totalPrice: {
          dinero: dinero({ amount: 200, currency: usd }),
          displayAmount: "$2",
        },
      },
      prorate: 1,
      cycleStartAt: Date.now() - 1_000,
      cycleEndAt: Date.now() + 1_000,
      usage: 2,
      included: 0,
      limit: 100,
      isTrial: false,
    }

    const mockRateBillingPeriod = vi.fn().mockResolvedValue(Ok([ratedCharge]))
    const ratingService = {
      rateBillingPeriod: mockRateBillingPeriod,
      resolveBillingWindow: vi.fn(),
    } as unknown as RatingService

    const billingService = buildBillingService(ratingService)
    const payload = {
      projectId: "proj_1",
      customerId: "cust_1",
      featureSlug: "api_requests",
      now: Date.now(),
    } as const

    const result = await billingService.calculateFeaturePrice(payload)

    expect(mockRateBillingPeriod).toHaveBeenCalledTimes(1)
    expect(mockRateBillingPeriod).toHaveBeenCalledWith(payload)
    expect(result.err).toBeUndefined()
    expect(result.val).toEqual([ratedCharge])
  })

  it("maps RatingService errors to UnPriceBillingError", async () => {
    const mockRateBillingPeriod = vi
      .fn()
      .mockResolvedValue(Err(new UnPriceRatingError({ message: "RATING_FAILED" })))
    const ratingService = {
      rateBillingPeriod: mockRateBillingPeriod,
      resolveBillingWindow: vi.fn(),
    } as unknown as RatingService

    const billingService = buildBillingService(ratingService)

    const result = await billingService.calculateFeaturePrice({
      projectId: "proj_1",
      customerId: "cust_1",
      featureSlug: "api_requests",
      now: Date.now(),
    })

    expect(result.err).toBeDefined()
    expect(result.err?.message).toContain("RATING_FAILED")
  })
})
