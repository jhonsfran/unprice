import type { Database } from "@unprice/db"
import { customers } from "@unprice/db/schema"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { fromCurrencyMinor, toLedgerMinor } from "@unprice/money"
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
  it("replays a signup for the same external id and email", async () => {
    const getCustomerByExternalId = vi.fn().mockResolvedValue(
      Ok({
        id: "cus_existing",
        email: "customer@example.com",
      })
    )

    const result = await signUp(
      {
        db: {} as Database,
        logger: createLogger(),
        analytics: {} as never,
        waitUntil: vi.fn(),
        services: {
          customers: { getCustomerByExternalId },
        } as never,
      },
      {
        projectId: "proj_123",
        input: {
          email: "Customer@Example.com",
          externalId: "user_123",
          successUrl: "https://example.com/success/{CUSTOMER_ID}",
          cancelUrl: "https://example.com/cancel",
        } as never,
      }
    )

    expect(result).toEqual(
      Ok({
        success: true,
        url: "https://example.com/success/cus_existing",
        customerId: "cus_existing",
      })
    )
    expect(getCustomerByExternalId).toHaveBeenCalledWith("proj_123", "user_123", {
      skipCache: true,
    })
  })

  it("keeps an external id conflict when the email differs", async () => {
    const result = await signUp(
      {
        db: {} as Database,
        logger: createLogger(),
        analytics: {} as never,
        waitUntil: vi.fn(),
        services: {
          customers: {
            getCustomerByExternalId: vi.fn().mockResolvedValue(
              Ok({
                id: "cus_existing",
                email: "owner@example.com",
              })
            ),
          },
        } as never,
      },
      {
        projectId: "proj_123",
        input: {
          email: "other@example.com",
          externalId: "user_123",
          successUrl: "https://example.com/success/{CUSTOMER_ID}",
          cancelUrl: "https://example.com/cancel",
        } as never,
      }
    )

    expect(result.err).toMatchObject({
      code: "CUSTOMER_EXTERNAL_ID_CONFLICT",
    })
  })

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

  it("allows sandbox signup and stores capped credit line at ledger scale", async () => {
    const expectedCreditLineAmount = toLedgerMinor(fromCurrencyMinor(10_000, "USD"))
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
    const generateBillingPeriods = vi
      .fn()
      .mockResolvedValue(Ok({ cyclesCreated: 1, phasesProcessed: 1 }))

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
          billing: {
            generateBillingPeriods,
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
          defaultCurrency: "USD",
          creditLinePolicy: "capped",
          creditLineAmountMinor: 10_000,
        } as never,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.success).toBe(true)
    expect(createSubscription).toHaveBeenCalled()
    expect(generateBillingPeriods).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      projectId: "proj_123",
      now: expect.any(Number),
      db: tx,
    })
    expect(createPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          paymentProvider: "sandbox",
          creditLinePolicy: "capped",
          creditLineAmount: expectedCreditLineAmount,
        }),
      })
    )
  })

  it("defaults the credit line policy to capped when the plan includes credits", async () => {
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
          findFirst: vi.fn().mockResolvedValue({
            ...createPlanVersion("sandbox"),
            metadata: { includedCreditAmount: 2_000_000_000 },
          }),
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
    const generateBillingPeriods = vi
      .fn()
      .mockResolvedValue(Ok({ cyclesCreated: 1, phasesProcessed: 1 }))

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
          billing: {
            generateBillingPeriods,
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
          defaultCurrency: "USD",
        } as never,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.success).toBe(true)
    expect(createPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          creditLinePolicy: "capped",
          creditLineAmount: null,
        }),
      })
    )
  })
  it("rolls back failed direct provisioning before an external-id retry", async () => {
    const committedCustomers = new Map<string, { id: string; email: string }>()
    const getCustomerByExternalId = vi.fn(async (_projectId: string, externalId: string) =>
      Ok(committedCustomers.get(externalId) ?? null)
    )
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
      transaction: vi.fn(async (callback: (tx: Database) => Promise<unknown>) => {
        const stagedCustomers = new Map(committedCustomers)
        const tx = {
          insert: vi.fn((table: unknown) => ({
            values: vi.fn((values: { id: string; email: string; externalId: string | null }) => {
              if (table !== customers) {
                return Promise.resolve()
              }

              if (values.externalId) {
                stagedCustomers.set(values.externalId, {
                  id: values.id,
                  email: values.email,
                })
              }

              return {
                returning: vi.fn().mockResolvedValue([{ id: values.id }]),
              }
            }),
          })),
        }
        const result = await callback(tx as unknown as Database)
        committedCustomers.clear()
        for (const [externalId, customer] of stagedCustomers) {
          committedCustomers.set(externalId, customer)
        }
        return result
      }),
    } as unknown as Database
    const createSubscription = vi.fn().mockResolvedValue(Ok({ id: "sub_123" }))
    const generateBillingPeriods = vi
      .fn()
      .mockResolvedValueOnce({ err: new Error("billing periods unavailable") })
      .mockResolvedValue(Ok({ cyclesCreated: 1, phasesProcessed: 1 }))
    const deps = {
      db,
      logger: createLogger(),
      analytics: {
        getPlanClickBySessionId: vi.fn(),
        ingestEvents: vi.fn().mockResolvedValue(undefined),
      } as never,
      waitUntil: vi.fn(),
      services: {
        customers: {
          getCustomerByExternalId,
          getPaymentProvider: vi.fn(),
        },
        subscriptions: {
          createSubscription,
          createPhase: vi.fn().mockResolvedValue(Ok({ id: "phase_123" })),
          getSubscriptionData: vi.fn().mockResolvedValue({ status: "inactive" }),
          activateWallet: vi.fn().mockResolvedValue(undefined),
        },
        billing: {
          generateBillingPeriods,
        },
        plans: {},
      } as never,
    }
    const input = {
      projectId: "proj_123",
      input: {
        email: "customer@example.com",
        externalId: "external_123",
        planVersionId: "version_123",
        successUrl: "https://example.com/success/{CUSTOMER_ID}",
        cancelUrl: "https://example.com/cancel",
      } as never,
    }

    const first = await signUp(deps, input)

    expect(first.val).toMatchObject({ success: false })
    expect(committedCustomers).toHaveLength(0)

    const second = await signUp(deps, input)

    expect(second.val).toMatchObject({ success: true })
    expect(committedCustomers).toHaveLength(1)
    expect(createSubscription).toHaveBeenCalledTimes(2)
    expect(generateBillingPeriods).toHaveBeenCalledTimes(2)
  })
})
