import type { Database } from "@unprice/db"
import { ledgerEntries, ledgers } from "@unprice/db/schema"
import type { LedgerEntry } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Metrics } from "../metrics"
import { LedgerService } from "./service"

vi.mock("../../env", () => ({
  env: { ENCRYPTION_KEY: "test_encryption_key" },
}))

vi.mock("@unprice/db/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@unprice/db/utils")>()
  return {
    ...actual,
    hashStringSHA256: vi.fn().mockImplementation(async (input: string) => `sha256_${input}`),
  }
})

describe("LedgerService", () => {
  let service: LedgerService
  let mockLogger: Logger
  let mockDb: Database
  let mockMetrics: Metrics

  // In-memory store simulating the DB
  let ledgerStore: Map<string, Record<string, unknown>>
  let entryStore: Map<string, LedgerEntry>

  beforeEach(() => {
    vi.clearAllMocks()
    ledgerStore = new Map()
    entryStore = new Map()

    mockLogger = {
      set: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    } as unknown as Logger

    mockMetrics = {} as unknown as Metrics

    // Build a mock DB that supports transaction, insert, update, query
    const buildExecutor = (): Database => {
      const executor = {
        transaction: vi.fn().mockImplementation(async (cb) => {
          return await cb(buildExecutor())
        }),
        execute: vi.fn().mockResolvedValue([]),
        insert: vi.fn().mockImplementation((table) => ({
          values: vi.fn().mockImplementation((values) => {
            if (table === ledgers) {
              const key = `${values.projectId}:${values.customerId}:${values.currency}`
              if (!ledgerStore.has(key)) {
                ledgerStore.set(key, { ...values })
              }
            }
            if (table === ledgerEntries) {
              const sourceKey = `${values.projectId}:${values.ledgerId}:${values.sourceType}:${values.sourceId}`
              if (!entryStore.has(sourceKey)) {
                entryStore.set(sourceKey, values as LedgerEntry)
                return {
                  onConflictDoNothing: vi.fn().mockReturnValue({
                    returning: vi.fn().mockImplementation(() => {
                      return Promise.resolve([values])
                    }),
                  }),
                  returning: vi.fn().mockResolvedValue([values]),
                }
              }
              // Conflict — entry already exists
              return {
                onConflictDoNothing: vi.fn().mockReturnValue({
                  returning: vi.fn().mockImplementation(() => {
                    return Promise.resolve([])
                  }),
                }),
                returning: vi.fn().mockResolvedValue([]),
              }
            }
            return {
              onConflictDoNothing: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([values]),
              }),
              returning: vi.fn().mockResolvedValue([values]),
            }
          }),
        })),
        update: vi.fn().mockImplementation((table) => ({
          set: vi.fn().mockImplementation((setData) => {
            if (table === ledgers) {
              // Update the ledger in-memory
              for (const [key, ledger] of ledgerStore.entries()) {
                if (setData.balanceCents !== undefined) {
                  ledger.balanceCents = setData.balanceCents
                }
                if (setData.unsettledBalanceCents !== undefined) {
                  ledger.unsettledBalanceCents = setData.unsettledBalanceCents
                }
                if (setData.lastEntryAt !== undefined) {
                  ledger.lastEntryAt = setData.lastEntryAt
                }
                ledgerStore.set(key, ledger)
              }
            }
            if (table === ledgerEntries) {
              for (const [key, entry] of entryStore.entries()) {
                if (entry.settledAt === null) {
                  entryStore.set(key, { ...entry, ...setData })
                }
              }
            }
            return {
              where: vi.fn().mockResolvedValue([]),
            }
          }),
        })),
        query: {
          ledgers: {
            findFirst: vi.fn().mockImplementation((_opts) => {
              for (const ledger of ledgerStore.values()) {
                return Promise.resolve(ledger)
              }
              return Promise.resolve(null)
            }),
          },
          ledgerEntries: {
            findFirst: vi.fn().mockImplementation(() => {
              // For idempotency check — look for existing entry by sourceType + sourceId
              return Promise.resolve(null)
            }),
            findMany: vi.fn().mockImplementation(() => {
              return Promise.resolve([...entryStore.values()])
            }),
          },
        },
      } as unknown as Database

      return executor
    }

    mockDb = buildExecutor()

    service = new LedgerService({
      db: mockDb,
      logger: mockLogger,
      metrics: mockMetrics,
    })
  })

  describe("postDebit / postCredit", () => {
    it("posts a debit entry successfully", async () => {
      const result = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountCents: 1000,
        sourceType: "test_charge",
        sourceId: "charge_1",
        now: 1000000,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toBeDefined()
      expect(result.val!.entryType).toBe("debit")
      expect(result.val!.amountCents).toBe(1000)
      expect(result.val!.signedAmountCents).toBe(1000)
    })

    it("posts a credit entry with negative signed amount", async () => {
      const result = await service.postCredit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountCents: 500,
        sourceType: "test_refund",
        sourceId: "refund_1",
        now: 1000000,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toBeDefined()
      expect(result.val!.entryType).toBe("credit")
      expect(result.val!.amountCents).toBe(500)
      expect(result.val!.signedAmountCents).toBe(-500)
    })

    it("rejects negative amounts", async () => {
      const result = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountCents: -100,
        sourceType: "test",
        sourceId: "bad_1",
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("LEDGER_INVALID_AMOUNT")
    })

    it("rejects non-finite amounts", async () => {
      const result = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountCents: Number.NaN,
        sourceType: "test",
        sourceId: "nan_1",
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("LEDGER_INVALID_AMOUNT")
    })

    it("rejects missing source identity", async () => {
      const result = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountCents: 100,
        sourceType: "",
        sourceId: "x",
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("LEDGER_SOURCE_IDENTITY_REQUIRED")
    })

    it("truncates fractional amounts", async () => {
      const result = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountCents: 99.7,
        sourceType: "test_trunc",
        sourceId: "trunc_1",
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.amountCents).toBe(99)
    })
  })

  describe("idempotency", () => {
    it("returns existing entry on duplicate sourceType + sourceId", async () => {
      const input = {
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD" as const,
        amountCents: 1000,
        sourceType: "subscription_billing_period_charge_v1",
        sourceId: "bp_1:si_1",
        now: 1000000,
      }

      const first = await service.postDebit(input)
      expect(first.err).toBeUndefined()

      // On the second call, the mock transaction should find the existing entry
      // via the existingEntry check (findFirst by sourceType + sourceId).
      // We need to patch findFirst on the inner tx's query, which is built fresh
      // by buildExecutor(). The simplest approach: patch the root mock so new
      // executors return the existing entry.
      const _origTransaction = mockDb.transaction
      // biome-ignore lint/suspicious/noExplicitAny: test mock needs to bypass Drizzle transaction types
      vi.spyOn(mockDb, "transaction").mockImplementation(async (cb: any, _config?: any) => {
        const innerExecutor = {
          execute: vi.fn().mockResolvedValue([]),
          insert: mockDb.insert,
          update: mockDb.update,
          query: {
            ledgers: {
              findFirst: vi.fn().mockImplementation(() => {
                for (const ledger of ledgerStore.values()) {
                  return Promise.resolve(ledger)
                }
                return Promise.resolve(null)
              }),
            },
            ledgerEntries: {
              // This time, findFirst returns the existing entry (idempotency hit)
              findFirst: vi.fn().mockResolvedValue(first.val),
              findMany: vi.fn().mockResolvedValue([...entryStore.values()]),
            },
          },
        }
        return await cb(innerExecutor)
      })

      const second = await service.postDebit(input)
      expect(second.err).toBeUndefined()
      // The entry from the first call should be returned
      expect(second.val!.sourceType).toBe(input.sourceType)
      expect(second.val!.sourceId).toBe(input.sourceId)
    })
  })

  describe("getUnsettledEntries", () => {
    it("returns empty array when no entries exist", async () => {
      const result = await service.getUnsettledEntries({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toEqual([])
    })

    it("filters by statementKey and subscriptionId", async () => {
      const entryA: LedgerEntry = {
        id: "le_1",
        projectId: "proj_1",
        createdAtM: 1000,
        updatedAtM: 1000,
        ledgerId: "ldg_1",
        customerId: "cust_1",
        currency: "USD",
        entryType: "debit",
        amountCents: 100,
        signedAmountCents: 100,
        sourceType: "test",
        sourceId: "s1",
        idempotencyKey: "k1",
        description: null,
        statementKey: "stmt_1",
        subscriptionId: "sub_1",
        subscriptionPhaseId: null,
        subscriptionItemId: null,
        billingPeriodId: null,
        featurePlanVersionId: null,
        invoiceItemKind: "period",
        cycleStartAt: null,
        cycleEndAt: null,
        quantity: 1,
        unitAmountCents: null,
        amountSubtotalCents: 100,
        amountTotalCents: 100,
        balanceAfterCents: 100,
        settlementType: null,
        settlementArtifactId: null,
        settlementPendingProviderConfirmation: false,
        settledAt: null,
        metadata: null,
      }

      entryStore.set("proj_1:ldg_1:test:s1", entryA)

      const result = await service.getUnsettledEntries({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        statementKey: "stmt_1",
        subscriptionId: "sub_1",
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.length).toBe(1)
    })
  })

  describe("getUnsettledBalance", () => {
    it("returns 0 when no ledger exists", async () => {
      const result = await service.getUnsettledBalance({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toBe(0)
    })

    it("returns unsettled balance from ledger", async () => {
      ledgerStore.set("proj_1:cust_1:USD", {
        id: "ldg_1",
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        balanceCents: 5000,
        unsettledBalanceCents: 3000,
      })

      const result = await service.getUnsettledBalance({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toBe(3000)
    })
  })

  describe("markSettled", () => {
    it("returns empty array for empty entryIds", async () => {
      const result = await service.markSettled({
        projectId: "proj_1",
        entryIds: [],
        settlementType: "invoice",
        settlementArtifactId: "inv_1",
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toEqual([])
    })

    it("settles entries and decrements unsettled balance", async () => {
      const entry: LedgerEntry = {
        id: "le_1",
        projectId: "proj_1",
        createdAtM: 1000,
        updatedAtM: 1000,
        ledgerId: "ldg_1",
        customerId: "cust_1",
        currency: "USD",
        entryType: "debit",
        amountCents: 1000,
        signedAmountCents: 1000,
        sourceType: "test",
        sourceId: "s1",
        idempotencyKey: "k1",
        description: null,
        statementKey: null,
        subscriptionId: null,
        subscriptionPhaseId: null,
        subscriptionItemId: null,
        billingPeriodId: null,
        featurePlanVersionId: null,
        invoiceItemKind: "period",
        cycleStartAt: null,
        cycleEndAt: null,
        quantity: 1,
        unitAmountCents: null,
        amountSubtotalCents: 1000,
        amountTotalCents: 1000,
        balanceAfterCents: 1000,
        settlementType: null,
        settlementArtifactId: null,
        settlementPendingProviderConfirmation: false,
        settledAt: null,
        metadata: null,
      }

      entryStore.set("proj_1:ldg_1:test:s1", entry)

      const result = await service.markSettled({
        projectId: "proj_1",
        entryIds: ["le_1"],
        settlementType: "invoice",
        settlementArtifactId: "inv_1",
        settlementPendingProviderConfirmation: true,
        now: 2000,
      })

      expect(result.err).toBeUndefined()
    })

    it("skips already-settled entries without error", async () => {
      const settledEntry: LedgerEntry = {
        id: "le_2",
        projectId: "proj_1",
        createdAtM: 1000,
        updatedAtM: 1000,
        ledgerId: "ldg_1",
        customerId: "cust_1",
        currency: "USD",
        entryType: "debit",
        amountCents: 500,
        signedAmountCents: 500,
        sourceType: "test",
        sourceId: "s2",
        idempotencyKey: "k2",
        description: null,
        statementKey: null,
        subscriptionId: null,
        subscriptionPhaseId: null,
        subscriptionItemId: null,
        billingPeriodId: null,
        featurePlanVersionId: null,
        invoiceItemKind: "period",
        cycleStartAt: null,
        cycleEndAt: null,
        quantity: 1,
        unitAmountCents: null,
        amountSubtotalCents: 500,
        amountTotalCents: 500,
        balanceAfterCents: 500,
        settlementType: "invoice",
        settlementArtifactId: "inv_old",
        settlementPendingProviderConfirmation: false,
        settledAt: 1500,
        metadata: null,
      }

      entryStore.set("proj_1:ldg_1:test:s2", settledEntry)

      const result = await service.markSettled({
        projectId: "proj_1",
        entryIds: ["le_2"],
        settlementType: "invoice",
        settlementArtifactId: "inv_2",
        now: 3000,
      })

      expect(result.err).toBeUndefined()
    })

    it("uses caller-provided transaction directly without nesting", async () => {
      const txSpy = vi.fn()
      const callerTx = {
        transaction: txSpy,
        query: {
          ledgerEntries: {
            findMany: vi.fn().mockResolvedValue([]),
          },
        },
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as unknown as Database

      await service.markSettled({
        projectId: "proj_1",
        entryIds: ["le_1"],
        settlementType: "invoice",
        settlementArtifactId: "inv_1",
        db: callerTx,
      })

      // When db is provided, should NOT call transaction on it
      expect(txSpy).not.toHaveBeenCalled()
    })
  })
})
