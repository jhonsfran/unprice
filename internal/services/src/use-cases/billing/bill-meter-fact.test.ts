import { USD } from "@dinero.js/currencies"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { dinero } from "dinero.js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { UnPriceLedgerError } from "../../ledger/errors"
import { UnPriceRatingError } from "../../rating/errors"
import { type MeterBillingFact, billMeterFact } from "./bill-meter-fact"

describe("billMeterFact", () => {
  const priceFromCents = (amount: number) => ({
    dinero: dinero({ amount, currency: USD }),
    displayAmount: (amount / 100).toFixed(2),
  })

  const baseFact: MeterBillingFact = {
    id: "stream_123:period_123:evt_123:meter_123",
    event_id: "evt_123",
    idempotency_key: "idem_123",
    project_id: "proj_123",
    customer_id: "cus_123",
    stream_id: "stream_123",
    feature_slug: "api_calls",
    period_key: "month:1709251200000",
    event_slug: "tokens_used",
    aggregation_method: "sum",
    timestamp: Date.UTC(2026, 2, 20, 12, 0, 0),
    created_at: Date.UTC(2026, 2, 20, 12, 0, 1),
    delta: 5,
    value_after: 25,
    currency: "USD",
    feature_plan_version_id: "fpv_123",
  }

  const mockRateIncrementalUsage = vi.fn()
  const mockPostDebit = vi.fn()
  const logger: Logger = {
    set: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger

  const deps = {
    services: {
      rating: {
        rateIncrementalUsage: mockRateIncrementalUsage,
      },
      ledger: {
        postDebit: mockPostDebit,
      },
    } as unknown as Pick<ServiceContext, "rating" | "ledger">,
    logger,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("rates incremental usage and posts an idempotent ledger debit", async () => {
    mockRateIncrementalUsage.mockResolvedValueOnce(
      Ok({
        usageBefore: 20,
        usageAfter: 25,
        usageDelta: 5,
        before: [],
        after: [],
        deltaPrice: {
          unitPrice: priceFromCents(500),
          subtotalPrice: priceFromCents(500),
          totalPrice: priceFromCents(500),
        },
      })
    )
    mockPostDebit.mockResolvedValueOnce(Ok({ id: "ledger_entry_123" }))

    const result = await billMeterFact(deps, {
      fact: baseFact,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({
      amountCents: 500,
      sourceId: "proj_123:cus_123:api_calls:idem_123",
      state: "debited",
    })
    expect(mockRateIncrementalUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        usageBefore: 20,
        usageAfter: 25,
        now: baseFact.timestamp,
      })
    )
    expect(mockPostDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "meter_fact_v1",
        sourceId: "proj_123:cus_123:api_calls:idem_123",
        featurePlanVersionId: "fpv_123",
        amountCents: 500,
      })
    )
  })

  it("returns noop when delta price is zero", async () => {
    mockRateIncrementalUsage.mockResolvedValueOnce(
      Ok({
        usageBefore: 20,
        usageAfter: 25,
        usageDelta: 5,
        before: [],
        after: [],
        deltaPrice: {
          unitPrice: priceFromCents(0),
          subtotalPrice: priceFromCents(0),
          totalPrice: priceFromCents(0),
        },
      })
    )

    const result = await billMeterFact(deps, {
      fact: baseFact,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({
      amountCents: 0,
      sourceId: "proj_123:cus_123:api_calls:idem_123",
      state: "noop",
    })
    expect(mockPostDebit).not.toHaveBeenCalled()
  })

  it("returns noop for negative delta (correction events)", async () => {
    const result = await billMeterFact(deps, {
      fact: { ...baseFact, delta: -3, value_after: 17 },
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({
      amountCents: 0,
      sourceId: "proj_123:cus_123:api_calls:idem_123",
      state: "noop",
    })
    expect(mockRateIncrementalUsage).not.toHaveBeenCalled()
    expect(mockPostDebit).not.toHaveBeenCalled()
  })

  it("returns noop for zero delta", async () => {
    const result = await billMeterFact(deps, {
      fact: { ...baseFact, delta: 0, value_after: 20 },
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.state).toBe("noop")
    expect(mockRateIncrementalUsage).not.toHaveBeenCalled()
  })

  it("returns error for invalid currency instead of silent fallback", async () => {
    const result = await billMeterFact(deps, {
      fact: { ...baseFact, currency: "INVALID" },
    })

    expect(result.err).toBeInstanceOf(UnPriceRatingError)
    expect(result.err?.message).toContain("Invalid currency")
    expect(mockRateIncrementalUsage).not.toHaveBeenCalled()
    expect(mockPostDebit).not.toHaveBeenCalled()
  })

  it("passes undefined featurePlanVersionId when fact has null value", async () => {
    mockRateIncrementalUsage.mockResolvedValueOnce(
      Ok({
        usageBefore: 20,
        usageAfter: 25,
        usageDelta: 5,
        before: [],
        after: [],
        deltaPrice: {
          unitPrice: priceFromCents(100),
          subtotalPrice: priceFromCents(100),
          totalPrice: priceFromCents(100),
        },
      })
    )
    mockPostDebit.mockResolvedValueOnce(Ok({ id: "ledger_entry_456" }))

    await billMeterFact(deps, {
      fact: { ...baseFact, feature_plan_version_id: null },
    })

    expect(mockPostDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        featurePlanVersionId: undefined,
      })
    )
  })

  it("propagates rating errors", async () => {
    mockRateIncrementalUsage.mockResolvedValueOnce(
      Err(
        new UnPriceRatingError({
          message: "RATING_FAILED",
        })
      )
    )

    const result = await billMeterFact(deps, {
      fact: baseFact,
    })

    expect(result.err).toBeInstanceOf(UnPriceRatingError)
    expect(mockPostDebit).not.toHaveBeenCalled()
  })

  it("propagates ledger errors", async () => {
    mockRateIncrementalUsage.mockResolvedValueOnce(
      Ok({
        usageBefore: 20,
        usageAfter: 25,
        usageDelta: 5,
        before: [],
        after: [],
        deltaPrice: {
          unitPrice: priceFromCents(100),
          subtotalPrice: priceFromCents(100),
          totalPrice: priceFromCents(100),
        },
      })
    )
    mockPostDebit.mockResolvedValueOnce(
      Err(
        new UnPriceLedgerError({
          message: "LEDGER_POST_ENTRY_FAILED",
        })
      )
    )

    const result = await billMeterFact(deps, {
      fact: baseFact,
    })

    expect(result.err).toBeInstanceOf(UnPriceLedgerError)
  })
})
