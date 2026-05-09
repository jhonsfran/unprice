import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PaymentProviderService } from "../../payment-provider/service"
import { completeProviderSignUp } from "./complete-provider-sign-up"

vi.mock("@unprice/db/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@unprice/db/utils")>()
  return {
    ...actual,
    newId: vi.fn().mockReturnValue("customer_provider_new"),
  }
})

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

describe("completeProviderSignUp", () => {
  let paymentProvider: PaymentProviderService
  let subscriptions: {
    createSubscription: ReturnType<typeof vi.fn>
    createPhase: ReturnType<typeof vi.fn>
    getSubscriptionData: ReturnType<typeof vi.fn>
    activateWallet: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    paymentProvider = {
      getSession: vi.fn().mockResolvedValue({
        val: {
          metadata: {
            customerSessionId: "customer_session_1",
            successUrl: "https://example.com/success",
            cancelUrl: "https://example.com/cancel",
          },
          customerId: "cus_stripe_1",
          subscriptionId: null,
        },
      }),
      setCustomerId: vi.fn(),
      listPaymentMethods: vi.fn().mockResolvedValue({
        val: [{ id: "pm_1" }],
      }),
    } as unknown as PaymentProviderService

    subscriptions = {
      createSubscription: vi.fn(),
      createPhase: vi.fn(),
      getSubscriptionData: vi.fn().mockResolvedValue({ status: "active" }),
      activateWallet: vi.fn().mockResolvedValue({ val: { status: "active" } }),
    }
  })

  it("reuses an existing subscription and phase when provider signup completion is replayed", async () => {
    const { db, txExecute, txInsert, txUpdate } = createReplayDb()
    const logger = createLogger()
    const analytics = {
      ingestEvents: vi.fn().mockResolvedValue(undefined),
    }
    const waitUntil = vi.fn()

    const result = await completeProviderSignUp(
      {
        services: {
          customers: {
            getPaymentProvider: vi.fn().mockResolvedValue({ val: paymentProvider }),
          } as never,
          subscriptions: subscriptions as never,
        },
        db,
        logger,
        analytics: analytics as never,
        waitUntil,
      },
      {
        projectId: "proj_1",
        provider: "stripe",
        sessionId: "cs_setup_1",
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.redirectUrl).toBe("https://example.com/success")
    expect(txExecute).toHaveBeenCalledTimes(1)
    expect(txInsert).toHaveBeenCalledTimes(1)
    expect(txUpdate).toHaveBeenCalledTimes(1)
    expect(subscriptions.createSubscription).not.toHaveBeenCalled()
    expect(subscriptions.createPhase).not.toHaveBeenCalled()
    expect(subscriptions.activateWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: "sub_existing",
        projectId: "proj_1",
      })
    )
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })
})

function createReplayDb() {
  const customerSession = {
    id: "customer_session_1",
    customer: {
      id: "cus_unprice_1",
      projectId: "proj_1",
      externalId: "ext_1",
      name: "Test Customer",
      email: "test@example.com",
      currency: "USD",
      timezone: "UTC",
      metadata: {},
    },
    planVersion: {
      id: "pv_1",
      projectId: "proj_1",
      config: [],
      creditLinePolicy: "uncapped",
      creditLineAmount: null,
      paymentMethodRequired: true,
    },
    metadata: {
      sessionId: "session_1",
      pageId: "page_1",
    },
  }

  const customerReturning = vi.fn().mockResolvedValue([
    {
      id: "cus_unprice_1",
      projectId: "proj_1",
    },
  ])
  const customerOnConflict = vi.fn().mockReturnValue({ returning: customerReturning })
  const customerValues = vi.fn().mockReturnValue({ onConflictDoUpdate: customerOnConflict })
  const dbInsert = vi.fn().mockReturnValue({ values: customerValues })

  const txExecute = vi.fn().mockResolvedValue({ rows: [] })
  const txOnConflict = vi.fn().mockResolvedValue(undefined)
  const txValues = vi.fn().mockReturnValue({ onConflictDoUpdate: txOnConflict })
  const txInsert = vi.fn().mockReturnValue({ values: txValues })
  const txUpdateWhere = vi.fn().mockResolvedValue(undefined)
  const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere })
  const txUpdate = vi.fn().mockReturnValue({ set: txUpdateSet })

  const tx = {
    execute: txExecute,
    insert: txInsert,
    update: txUpdate,
    query: {
      subscriptions: {
        findFirst: vi.fn().mockResolvedValue({
          id: "sub_existing",
          phases: [{ id: "phase_existing" }],
        }),
      },
    },
  }

  const db = {
    insert: dbInsert,
    transaction: vi.fn(async (cb: (transaction: typeof tx) => Promise<unknown>) => cb(tx)),
    query: {
      customerSessions: {
        findFirst: vi.fn().mockResolvedValue(customerSession),
      },
    },
  } as unknown as Database

  return {
    db,
    txExecute,
    txInsert,
    txUpdate,
  }
}
