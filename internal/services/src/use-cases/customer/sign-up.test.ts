import type { Database } from "@unprice/db"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import { UnPriceCustomerError } from "../../customers/errors"
import { signUp } from "./sign-up"

function createLogger(): Logger {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createPlanVersion(paymentProvider: "stripe" | "sandbox") {
  return {
    id: "version_123",
    projectId: "proj_123",
    planId: "plan_123",
    status: "published",
    active: true,
    currency: "USD",
    paymentProvider,
    paymentMethodRequired: false,
    billingConfig: {
      billingInterval: "month",
    },
    project: {
      id: "proj_123",
      defaultCurrency: "USD",
      timezone: "UTC",
    },
    plan: {
      id: "plan_123",
      slug: "pro",
    },
  }
}

describe("customer signUp payment provider guard", () => {
  it("rejects signup when the plan payment provider is disabled", async () => {
    const db = {
      query: {
        versions: {
          findFirst: vi.fn().mockResolvedValue(createPlanVersion("stripe")),
        },
        paymentProviderConfig: {
          findFirst: vi.fn().mockResolvedValue({
            id: "ppc_123",
            projectId: "proj_123",
            paymentProvider: "stripe",
            active: false,
            connectionType: "managed_connection",
            mode: "test",
            status: "active",
            externalAccountId: "acct_123",
          }),
        },
      },
    } as unknown as Database

    const result = await signUp(
      {
        db,
        logger: createLogger(),
        analytics: {
          getPlanClickBySessionId: vi.fn(),
          ingestEvents: vi.fn(),
        } as never,
        waitUntil: vi.fn(),
        services: {
          customers: {
            getCustomerByExternalId: vi.fn(),
            getPaymentProvider: vi.fn(),
          },
          subscriptions: {
            createSubscription: vi.fn(),
            createPhase: vi.fn(),
          },
          plans: {},
        } as never,
      },
      {
        projectId: "proj_123",
        input: {
          email: "customer@example.com",
          planVersionId: "version_123",
          successUrl: "https://example.com/success/{CUSTOMER_ID}",
          cancelUrl: "https://example.com/cancel",
        } as never,
      }
    )

    expect(result.err).toBeInstanceOf(UnPriceCustomerError)
    expect(result.err?.message).toMatch(/Stripe is disabled/)
  })

  it("allows sandbox signup when sandbox is enabled without keys", async () => {
    let insertCount = 0
    const tx = {
      insert: vi.fn(() => {
        insertCount += 1
        if (insertCount === 1) {
          return {
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([
                {
                  id: "cus_123",
                },
              ]),
            }),
          }
        }

        return {
          values: vi.fn().mockResolvedValue(undefined),
        }
      }),
    }
    const db = {
      query: {
        versions: {
          findFirst: vi.fn().mockResolvedValue(createPlanVersion("sandbox")),
        },
        paymentProviderConfig: {
          findFirst: vi.fn().mockResolvedValue({
            id: "ppc_123",
            projectId: "proj_123",
            paymentProvider: "sandbox",
            active: true,
            connectionType: "managed_connection",
            mode: "test",
            status: "active",
            key: null,
            keyIv: null,
          }),
        },
      },
      transaction: vi.fn(async (callback: (tx: Database) => Promise<unknown>) =>
        callback(tx as unknown as Database)
      ),
    } as unknown as Database
    const createSubscription = vi.fn().mockResolvedValue(Ok({ id: "sub_123" }))
    const createPhase = vi.fn().mockResolvedValue(Ok({ id: "phase_123" }))

    const result = await signUp(
      {
        db,
        logger: createLogger(),
        analytics: {
          getPlanClickBySessionId: vi.fn(),
          ingestEvents: vi.fn().mockResolvedValue(undefined),
        } as never,
        waitUntil: vi.fn(),
        services: {
          customers: {
            getCustomerByExternalId: vi.fn(),
            getPaymentProvider: vi.fn(),
          },
          subscriptions: {
            createSubscription,
            createPhase,
            getSubscriptionData: vi.fn().mockResolvedValue({ status: "inactive" }),
            activateWallet: vi.fn().mockResolvedValue(undefined),
          },
          plans: {},
        } as never,
      },
      {
        projectId: "proj_123",
        input: {
          email: "customer@example.com",
          planVersionId: "version_123",
          successUrl: "https://example.com/success/{CUSTOMER_ID}",
          cancelUrl: "https://example.com/cancel",
        } as never,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.success).toBe(true)
    expect(createSubscription).toHaveBeenCalled()
    expect(createPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          paymentProvider: "sandbox",
        }),
      })
    )
  })
})
