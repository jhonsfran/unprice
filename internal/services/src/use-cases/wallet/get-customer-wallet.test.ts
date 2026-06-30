import type { Customer } from "@unprice/db/validators"
import { Err, FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { CustomerService } from "../../customers/service"
import type { WalletCreditWithConsumption, WalletService, WalletStateOutput } from "../../wallet"
import { UnPriceWalletError } from "../../wallet"
import { getCustomerWallet } from "./get-customer-wallet"

describe("getCustomerWallet", () => {
  it("returns the project customer with wallet balances and active credits", async () => {
    const customer = createCustomer()
    const walletState = createWalletState()
    const customers = {
      getCustomerByIdInProject: vi.fn().mockResolvedValue(Ok(customer)),
    }
    const wallet = {
      getWalletState: vi.fn().mockResolvedValue(Ok(walletState)),
    }
    const logger = createLogger()

    const result = await getCustomerWallet(
      {
        services: {
          customers: customers as unknown as CustomerService,
          wallet: wallet as unknown as WalletService,
        },
        logger: logger,
      },
      {
        projectId: "proj_123",
        customerId: "cus_123",
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      customer: {
        id: "cus_123",
        projectId: "proj_123",
        defaultCurrency: "USD",
      },
      wallet: {
        currency: "USD",
        balances: {
          purchased: 1_000_000_000,
          granted: 500_000_000,
          reserved: 250_000_000,
          consumed: 2_000_000_000,
        },
      },
    })
    expect(result.val?.wallet.credits.map((credit) => credit.id)).toEqual(["wcr_123"])
    expect(result.val?.wallet.credits[0]).toMatchObject({
      consumedAmount: 0,
      status: "active",
      usableAmount: 500_000_000,
    })
    expect(wallet.getWalletState).toHaveBeenCalledWith({
      projectId: "proj_123",
      customerId: "cus_123",
    })
    expect(logger.set).toHaveBeenCalledWith({
      business: {
        operation: "wallet.get_customer_wallet",
        project_id: "proj_123",
        customer_id: "cus_123",
      },
    })
  })

  it("excludes expired credits from display granted balance and marks them expired", async () => {
    const customer = createCustomer()
    const activeCredit = createWalletCredit({
      id: "wcr_active",
      issuedAmount: 300_000_000,
      remainingAmount: 300_000_000,
      expiresAt: new Date("2026-06-23T00:00:00.000Z"),
    })
    const expiredCredit = createWalletCredit({
      id: "wcr_expired",
      issuedAmount: 200_000_000,
      remainingAmount: 200_000_000,
      expiresAt: new Date("2026-06-21T00:00:00.000Z"),
    })
    const walletState = createWalletState({
      balances: {
        purchased: 100_000_000,
        granted: 500_000_000,
        reserved: 0,
        consumed: 0,
      },
      credits: [activeCredit, expiredCredit],
    })
    const customers = {
      getCustomerByIdInProject: vi.fn().mockResolvedValue(Ok(customer)),
    }
    const wallet = {
      getWalletState: vi.fn().mockResolvedValue(Ok(walletState)),
    }

    const result = await getCustomerWallet(
      {
        services: {
          customers: customers as unknown as CustomerService,
          wallet: wallet as unknown as WalletService,
        },
        logger: createLogger(),
        now: () => new Date("2026-06-22T00:00:00.000Z"),
      },
      {
        projectId: "proj_123",
        customerId: "cus_123",
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.wallet.balances).toMatchObject({
      purchased: 100_000_000,
      granted: 300_000_000,
    })
    const creditsById = new Map(result.val?.wallet.credits.map((credit) => [credit.id, credit]))

    expect(creditsById.get("wcr_active")).toMatchObject({
      consumedAmount: 0,
      status: "active",
      usableAmount: 300_000_000,
    })
    expect(creditsById.get("wcr_expired")).toMatchObject({
      consumedAmount: 0,
      status: "expired",
      usableAmount: 0,
    })
  })

  it("orders credits by creation time newest first", async () => {
    const customer = createCustomer()
    const walletState = createWalletState({
      credits: [
        createWalletCredit({
          id: "wcr_old",
          createdAt: new Date("2026-06-22T10:00:00.000Z"),
        }),
        createWalletCredit({
          id: "wcr_new",
          createdAt: new Date("2026-06-22T12:00:00.000Z"),
        }),
        createWalletCredit({
          id: "wcr_middle",
          createdAt: new Date("2026-06-22T11:00:00.000Z"),
        }),
      ],
    })
    const customers = {
      getCustomerByIdInProject: vi.fn().mockResolvedValue(Ok(customer)),
    }
    const wallet = {
      getWalletState: vi.fn().mockResolvedValue(Ok(walletState)),
    }

    const result = await getCustomerWallet(
      {
        services: {
          customers: customers as unknown as CustomerService,
          wallet: wallet as unknown as WalletService,
        },
        logger: createLogger(),
        now: () => new Date("2026-06-22T13:00:00.000Z"),
      },
      {
        projectId: "proj_123",
        customerId: "cus_123",
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.wallet.credits.map((credit) => credit.id)).toEqual([
      "wcr_new",
      "wcr_middle",
      "wcr_old",
    ])
  })

  it("returns null when the customer is not in the project", async () => {
    const customers = {
      getCustomerByIdInProject: vi.fn().mockResolvedValue(Ok(null)),
    }
    const wallet = {
      getWalletState: vi.fn(),
    }

    const result = await getCustomerWallet(
      {
        services: {
          customers: customers as unknown as CustomerService,
          wallet: wallet as unknown as WalletService,
        },
        logger: createLogger(),
      },
      {
        projectId: "proj_123",
        customerId: "cus_missing",
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val).toBeNull()
    expect(wallet.getWalletState).not.toHaveBeenCalled()
  })

  it("returns the customer service error without reading the wallet", async () => {
    const customerError = new FetchError({
      message: "customer query failed",
      retry: false,
    })
    const customers = {
      getCustomerByIdInProject: vi.fn().mockResolvedValue(Err(customerError)),
    }
    const wallet = {
      getWalletState: vi.fn(),
    }

    const result = await getCustomerWallet(
      {
        services: {
          customers: customers as unknown as CustomerService,
          wallet: wallet as unknown as WalletService,
        },
        logger: createLogger(),
      },
      {
        projectId: "proj_123",
        customerId: "cus_123",
      }
    )

    expect(result.err).toBe(customerError)
    expect(wallet.getWalletState).not.toHaveBeenCalled()
  })

  it("returns the wallet service error", async () => {
    const walletError = new UnPriceWalletError({
      message: "WALLET_LEDGER_FAILED",
    })
    const customers = {
      getCustomerByIdInProject: vi.fn().mockResolvedValue(Ok(createCustomer())),
    }
    const wallet = {
      getWalletState: vi.fn().mockResolvedValue(Err(walletError)),
    }

    const result = await getCustomerWallet(
      {
        services: {
          customers: customers as unknown as CustomerService,
          wallet: wallet as unknown as WalletService,
        },
        logger: createLogger(),
      },
      {
        projectId: "proj_123",
        customerId: "cus_123",
      }
    )

    expect(result.err).toBe(walletError)
  })
})

function createCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: "cus_123",
    projectId: "proj_123",
    email: "billing@example.com",
    name: "Example Customer",
    description: "Customer with wallet credits",
    externalId: null,
    metadata: {},
    active: true,
    isMain: false,
    defaultCurrency: "USD",
    timezone: "UTC",
    createdAtM: 1_720_000_000_000,
    updatedAtM: 1_720_000_000_000,
    ...overrides,
  } as Customer
}

function createWalletCredit(
  overrides: Partial<WalletCreditWithConsumption> = {}
): WalletCreditWithConsumption {
  return {
    id: "wcr_123",
    projectId: "proj_123",
    customerId: "cus_123",
    source: "manual",
    consumedAmount: 0,
    issuedAmount: 500_000_000,
    remainingAmount: 500_000_000,
    expiresAt: null,
    expiredAt: null,
    voidedAt: null,
    ledgerTransferId: "pgle_123",
    metadata: null,
    createdAt: new Date("2026-06-22T10:00:00.000Z"),
    ...overrides,
  } as WalletCreditWithConsumption
}

function createWalletState(overrides: Partial<WalletStateOutput> = {}): WalletStateOutput {
  return {
    balances: {
      purchased: 1_000_000_000,
      granted: 500_000_000,
      reserved: 250_000_000,
      consumed: 2_000_000_000,
    },
    credits: [createWalletCredit()],
    ...overrides,
  }
}

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
