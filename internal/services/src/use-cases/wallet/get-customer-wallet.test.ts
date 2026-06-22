import type { Customer, WalletCredit } from "@unprice/db/validators"
import { Err, FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { CustomerService } from "../../customers/service"
import type { WalletService, WalletStateOutput } from "../../wallet"
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

function createWalletCredit(overrides: Partial<WalletCredit> = {}): WalletCredit {
  return {
    id: "wcr_123",
    projectId: "proj_123",
    customerId: "cus_123",
    source: "manual",
    issuedAmount: 500_000_000,
    remainingAmount: 300_000_000,
    expiresAt: null,
    expiredAt: null,
    voidedAt: null,
    ledgerTransferId: "pgle_123",
    metadata: null,
    createdAt: new Date("2026-06-22T10:00:00.000Z"),
    ...overrides,
  } as WalletCredit
}

function createWalletState(): WalletStateOutput {
  return {
    balances: {
      purchased: 1_000_000_000,
      granted: 500_000_000,
      reserved: 250_000_000,
      consumed: 2_000_000_000,
    },
    credits: [createWalletCredit()],
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
