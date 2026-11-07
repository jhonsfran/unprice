import type { Database } from "@unprice/db"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache"
import type { CustomerService } from "../customers/service"
import type { GrantsManager } from "../entitlements"
import type { LedgerGateway } from "../ledger"
import type { Metrics } from "../metrics"
import { createInvoicingStub } from "../test-fixtures/billing-gateway"
import type { WalletService } from "../wallet"
import { BillingService } from "./service"

describe("BillingService statement lines", () => {
  const buildBillingService = (
    overrides: {
      db?: Database
      ledgerService?: LedgerGateway
    } = {}
  ) =>
    new BillingService({
      invoicing: createInvoicingStub(),
      db: overrides.db ?? ({} as Database),
      logger: {
        set: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      } as unknown as Logger,
      waitUntil: (promise: Promise<unknown>) => promise,
      cache: {} as Cache,
      metrics: {} as Metrics,
      customerService: {} as CustomerService,
      grantsManager: {} as GrantsManager,
      ledgerService: overrides.ledgerService ?? ({} as LedgerGateway),
      walletService: {} as WalletService,
    })

  it("adds zero-amount statement lines for invoiced periods without ledger lines", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "bp_1",
        statementKey: "statement_1",
        type: "normal",
        invoiceAt: 1_768_000_000_000,
        cycleStartAt: 1_768_000_000_000,
        cycleEndAt: 1_770_678_400_000,
        subscriptionItem: {
          units: 1,
          featurePlanVersion: {
            featureType: "flat",
            feature: {
              title: "Access Free",
              slug: "access-free",
            },
          },
        },
      },
    ])
    const db = {
      query: {
        billingPeriods: {
          findMany,
        },
      },
    } as unknown as Database
    const ledgerService = {
      getInvoiceLines: vi.fn().mockResolvedValue(Ok([])),
    } as unknown as LedgerGateway
    const billingService = buildBillingService({ db, ledgerService })

    const result = await billingService.getInvoiceStatementLines({
      projectId: "proj_1",
      invoiceId: "inv_1",
      statementKey: "statement_1",
      currency: "EUR",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual([
      expect.objectContaining({
        entryId: "billing-period:bp_1",
        description: "Access Free",
        quantity: 1,
        amount: 0,
        currency: "EUR",
        servicePeriodStartAt: 1_768_000_000_000,
        servicePeriodEndAt: 1_770_678_400_000,
        prorationFactor: null,
      }),
    ])
  })
})
