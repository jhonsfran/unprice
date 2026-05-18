import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { dinero, toSnapshot } from "@unprice/money"
import * as currencies from "@unprice/money"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { customerAccountKeys, platformAccountKey } from "./accounts"
import { UnPriceLedgerError } from "./errors"
import { LedgerGateway, type LedgerTransferRequest } from "./gateway"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usd(amount: number) {
  return dinero({ amount: amount * 100_000_000, currency: currencies.currencies.USD, scale: 8 })
}

function makeAccountRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: overrides.id ?? "acc-1",
    name: overrides.name ?? "test-account",
    currency: overrides.currency ?? "USD",
    balance: overrides.balance ?? "0.00000000",
    version: overrides.version ?? "1",
    allow_negative_balance: overrides.allow_negative_balance ?? true,
    allow_positive_balance: overrides.allow_positive_balance ?? true,
    metadata: (overrides.metadata as Record<string, unknown>) ?? null,
  }
}

function makeTransferRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: overrides.id ?? "txn-1",
    from_account_id: overrides.from_account_id ?? "acc-from",
    to_account_id: overrides.to_account_id ?? "acc-to",
    amount: overrides.amount ?? "10.00000000",
    created_at: overrides.created_at ?? new Date("2024-01-01"),
    event_at: overrides.event_at ?? new Date("2024-01-01"),
    metadata: (overrides.metadata as Record<string, unknown>) ?? null,
    currency: overrides.currency ?? "USD",
  }
}

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

type ExecuteHandler = (sqlString: string) => { rows: unknown[] }

/**
 * Extracts a rough SQL string from a Drizzle sql tagged template object.
 * Falls back to JSON stringification if the object shape is unexpected.
 */
function extractSqlString(sqlObj: unknown): string {
  if (typeof sqlObj === "string") return sqlObj
  // Drizzle sql templates have a `queryChunks` or similar internal.
  // JSON.stringify captures the template strings embedded in the object.
  try {
    return JSON.stringify(sqlObj)
  } catch {
    return String(sqlObj)
  }
}

function createMockDb(handler: ExecuteHandler) {
  const execute = vi.fn((_sql: unknown) => {
    const sqlStr = extractSqlString(_sql)
    return Promise.resolve(handler(sqlStr))
  })

  const mockUpdate = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  }))

  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    return fn({ execute, update: mockUpdate })
  })

  return { execute, transaction, update: mockUpdate } as unknown as Database & {
    execute: ReturnType<typeof vi.fn>
    transaction: ReturnType<typeof vi.fn>
  }
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LedgerGateway", () => {
  let db: ReturnType<typeof createMockDb>
  let logger: ReturnType<typeof createMockLogger>
  let gateway: LedgerGateway

  const projectId = "proj-123"
  const customerId = "cust-456"

  beforeEach(() => {
    logger = createMockLogger()
  })

  // -------------------------------------------------------------------------
  // createTransfer
  // -------------------------------------------------------------------------

  describe("createTransfer", () => {
    it("happy path — claims idempotency, runs transfer, returns transfer", async () => {
      const fromName = platformAccountKey("topup", projectId)
      const toName = customerAccountKeys(customerId).purchased

      db = createMockDb((sql) => {
        // Idempotency INSERT → new row inserted
        if (sql.includes("unprice_ledger_idempotency") && sql.includes("INSERT")) {
          return { rows: [{ transfer_id: null }] }
        }
        // Account lookups
        if (sql.includes("pgledger_accounts_view")) {
          if (sql.includes(fromName)) {
            return { rows: [makeAccountRow({ id: "acc-from", name: fromName })] }
          }
          return { rows: [makeAccountRow({ id: "acc-to", name: toName })] }
        }
        // pgledger_create_transfer
        if (sql.includes("pgledger_create_transfer")) {
          return {
            rows: [
              makeTransferRow({
                id: "txn-new",
                from_account_id: "acc-from",
                to_account_id: "acc-to",
              }),
            ],
          }
        }
        return { rows: [] }
      })

      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      const request: LedgerTransferRequest = {
        projectId,
        fromAccount: fromName,
        toAccount: toName,
        amount: usd(10),
        source: { type: "topup", id: "topup-1" },
        statementKey: "stmt-1",
        metadata: { kind: "topup" },
      }

      const result = await gateway.createTransfer(request)

      expect(result.err).toBeUndefined()
      expect(result.val!.id).toBe("txn-new")
      expect(result.val!.fromAccountId).toBe("acc-from")
      expect(result.val!.toAccountId).toBe("acc-to")
      expect(result.val!.currency).toBe("USD")
    })

    it("idempotent replay — returns existing transfer without re-posting", async () => {
      const fromName = platformAccountKey("topup", projectId)
      const toName = customerAccountKeys(customerId).purchased

      db = createMockDb((sql) => {
        // Idempotency INSERT → conflict (no rows returned)
        if (sql.includes("unprice_ledger_idempotency") && sql.includes("INSERT")) {
          return { rows: [] }
        }
        // SELECT existing idempotency row
        if (sql.includes("unprice_ledger_idempotency") && sql.includes("SELECT")) {
          return { rows: [{ transfer_id: "txn-existing" }] }
        }
        // Fetch existing transfer via pgledger_transfers_view
        if (sql.includes("pgledger_transfers_view")) {
          return {
            rows: [
              makeTransferRow({
                id: "txn-existing",
                from_account_id: "acc-from",
                to_account_id: "acc-to",
              }),
            ],
          }
        }
        if (sql.includes("pgledger_accounts_view")) {
          if (sql.includes(fromName)) {
            return { rows: [makeAccountRow({ id: "acc-from", name: fromName })] }
          }
          return { rows: [makeAccountRow({ id: "acc-to", name: toName })] }
        }
        return { rows: [] }
      })

      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      const result = await gateway.createTransfer({
        projectId,
        fromAccount: fromName,
        toAccount: toName,
        amount: usd(10),
        source: { type: "topup", id: "topup-1" },
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.id).toBe("txn-existing")
    })

    it("idempotent replay with a different amount returns a conflict", async () => {
      const fromName = platformAccountKey("topup", projectId)
      const toName = customerAccountKeys(customerId).purchased

      db = createMockDb((sql) => {
        if (sql.includes("unprice_ledger_idempotency") && sql.includes("INSERT")) {
          return { rows: [] }
        }
        if (sql.includes("unprice_ledger_idempotency") && sql.includes("SELECT")) {
          return { rows: [{ transfer_id: "txn-existing", statement_key: "stmt-1" }] }
        }
        if (sql.includes("pgledger_transfers_view")) {
          return {
            rows: [
              makeTransferRow({
                id: "txn-existing",
                from_account_id: "acc-from",
                to_account_id: "acc-to",
                amount: "10.00000000",
              }),
            ],
          }
        }
        if (sql.includes("pgledger_accounts_view")) {
          if (sql.includes(fromName)) {
            return { rows: [makeAccountRow({ id: "acc-from", name: fromName })] }
          }
          return { rows: [makeAccountRow({ id: "acc-to", name: toName })] }
        }
        return { rows: [] }
      })

      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      const result = await gateway.createTransfer({
        projectId,
        fromAccount: fromName,
        toAccount: toName,
        amount: usd(11),
        source: { type: "topup", id: "topup-1" },
        statementKey: "stmt-1",
      })

      expect(result.err).toBeDefined()
      expect(result.err).toBeInstanceOf(UnPriceLedgerError)
      expect(result.err!.message).toBe("LEDGER_IDEMPOTENCY_CONFLICT")
    })

    it("currency mismatch — returns error", async () => {
      const fromName = platformAccountKey("topup", projectId)
      const toName = customerAccountKeys(customerId).purchased

      db = createMockDb((sql) => {
        if (sql.includes("unprice_ledger_idempotency") && sql.includes("INSERT")) {
          return { rows: [{ transfer_id: null }] }
        }
        // Return EUR accounts while amount is USD
        if (sql.includes("pgledger_accounts_view")) {
          return { rows: [makeAccountRow({ id: "acc-1", currency: "EUR" })] }
        }
        return { rows: [] }
      })

      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      const result = await gateway.createTransfer({
        projectId,
        fromAccount: fromName,
        toAccount: toName,
        amount: usd(10),
        source: { type: "topup", id: "topup-2" },
      })

      expect(result.err).toBeDefined()
      expect(result.err).toBeInstanceOf(UnPriceLedgerError)
      expect(result.err!.message).toBe("LEDGER_CURRENCY_MISMATCH")
    })
  })

  // -------------------------------------------------------------------------
  // createTransfers (batched)
  // -------------------------------------------------------------------------

  describe("createTransfers", () => {
    it("posts N transfers with individual idempotency keys", async () => {
      const fromName = platformAccountKey("topup", projectId)
      const toName = customerAccountKeys(customerId).purchased
      let transferCount = 0

      db = createMockDb((sql) => {
        if (sql.includes("unprice_ledger_idempotency") && sql.includes("INSERT")) {
          return { rows: [{ transfer_id: null }] }
        }
        if (sql.includes("pgledger_accounts_view")) {
          return { rows: [makeAccountRow({ id: "acc-1", currency: "USD" })] }
        }
        if (sql.includes("pgledger_create_transfer")) {
          transferCount++
          return { rows: [makeTransferRow({ id: `txn-batch-${transferCount}` })] }
        }
        return { rows: [] }
      })

      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      const requests: LedgerTransferRequest[] = [
        {
          projectId,
          fromAccount: fromName,
          toAccount: toName,
          amount: usd(5),
          source: { type: "usage", id: "evt-1" },
          statementKey: "stmt-1",
        },
        {
          projectId,
          fromAccount: fromName,
          toAccount: toName,
          amount: usd(3),
          source: { type: "usage", id: "evt-2" },
          statementKey: "stmt-1",
        },
      ]

      const result = await gateway.createTransfers(requests)

      expect(result.err).toBeUndefined()
      expect(result.val!).toHaveLength(2)
      expect(result.val![0]!.id).toBe("txn-batch-1")
      expect(result.val![1]!.id).toBe("txn-batch-2")
    })

    it("returns Ok([]) for empty request array", async () => {
      db = createMockDb(() => ({ rows: [] }))
      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      const result = await gateway.createTransfers([])
      expect(result.err).toBeUndefined()
      expect(result.val!).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // getInvoiceLines
  // -------------------------------------------------------------------------

  describe("getInvoiceLines", () => {
    it("returns projected invoice lines with correct amounts and kind", async () => {
      db = createMockDb((sql) => {
        if (sql.includes("unprice_ledger_idempotency") && sql.includes("pgledger_entries_view")) {
          return {
            rows: [
              {
                id: "entry-1",
                amount: "5.00000000",
                created_at: new Date("2024-02-01"),
                metadata: { kind: "flat", description: "Base fee", quantity: 1 },
                currency: "USD",
              },
              {
                id: "entry-2",
                amount: "2.50000000",
                created_at: new Date("2024-02-02"),
                metadata: { kind: "usage", description: "API calls", quantity: 250 },
                currency: "USD",
              },
            ],
          }
        }
        return { rows: [] }
      })

      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      const result = await gateway.getInvoiceLines({
        projectId,
        statementKey: "stmt-abc",
      })

      expect(result.err).toBeUndefined()
      expect(result.val!).toHaveLength(2)
      expect(result.val![0]!.entryId).toBe("entry-1")
      expect(result.val![0]!.kind).toBe("flat")
      expect(result.val![0]!.description).toBe("Base fee")
      expect(result.val![0]!.quantity).toBe(1)
      expect(result.val![0]!.statementKey).toBe("stmt-abc")
      expect(result.val![1]!.kind).toBe("usage")
      expect(result.val![1]!.quantity).toBe(250)
    })

    it("returns empty array when no entries match", async () => {
      db = createMockDb(() => ({ rows: [] }))
      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      const result = await gateway.getInvoiceLines({
        projectId,
        statementKey: "stmt-none",
      })

      expect(result.err).toBeUndefined()
      expect(result.val!).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // seedPlatformAccounts
  // -------------------------------------------------------------------------

  describe("seedPlatformAccounts", () => {
    it("creates 5 platform funding accounts", async () => {
      db = createMockDb((sql) => {
        if (sql.includes("pgledger_accounts_view")) return { rows: [] }
        if (sql.includes("pgledger_create_account")) {
          return { rows: [makeAccountRow()] }
        }
        return { rows: [] }
      })

      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      const result = await gateway.seedPlatformAccounts(projectId, "USD")

      expect(result.err).toBeUndefined()
      expect(db.transaction).toHaveBeenCalledTimes(1)
    })

    it("second call is a cached no-op", async () => {
      db = createMockDb((sql) => {
        if (sql.includes("pgledger_accounts_view")) return { rows: [] }
        if (sql.includes("pgledger_create_account")) {
          return { rows: [makeAccountRow()] }
        }
        return { rows: [] }
      })

      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      await gateway.seedPlatformAccounts(projectId, "USD")
      const result2 = await gateway.seedPlatformAccounts(projectId, "USD")

      expect(result2.err).toBeUndefined()
      expect(db.transaction).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // ensureCustomerAccounts
  // -------------------------------------------------------------------------

  describe("ensureCustomerAccounts", () => {
    it("creates 5 customer sub-accounts", async () => {
      db = createMockDb((sql) => {
        if (sql.includes("pgledger_accounts_view")) return { rows: [] }
        if (sql.includes("pgledger_create_account")) {
          return { rows: [makeAccountRow()] }
        }
        return { rows: [] }
      })

      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      const result = await gateway.ensureCustomerAccounts(customerId, "USD")

      expect(result.err).toBeUndefined()
      expect(db.transaction).toHaveBeenCalledTimes(1)
    })

    it("second call is a cached no-op", async () => {
      db = createMockDb((sql) => {
        if (sql.includes("pgledger_accounts_view")) return { rows: [] }
        if (sql.includes("pgledger_create_account")) {
          return { rows: [makeAccountRow()] }
        }
        return { rows: [] }
      })

      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      await gateway.ensureCustomerAccounts(customerId, "USD")
      const result2 = await gateway.ensureCustomerAccounts(customerId, "USD")

      expect(result2.err).toBeUndefined()
      expect(db.transaction).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // getAccountBalance
  // -------------------------------------------------------------------------

  describe("getAccountBalance", () => {
    it("returns balance from accounts view", async () => {
      const accountName = customerAccountKeys(customerId).purchased

      db = createMockDb((sql) => {
        if (sql.includes("pgledger_accounts_view")) {
          return {
            rows: [
              makeAccountRow({
                name: accountName,
                balance: "25.00000000",
                currency: "USD",
              }),
            ],
          }
        }
        return { rows: [] }
      })

      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      const result = await gateway.getAccountBalance(accountName)

      expect(result.err).toBeUndefined()
      const snap = toSnapshot(result.val!)
      expect(snap.amount).toBe(2500000000)
      expect(snap.currency.code).toBe("USD")
    })

    it("returns error when account not found", async () => {
      db = createMockDb(() => ({ rows: [] }))
      gateway = new LedgerGateway({ db: db as unknown as Database, logger })

      const result = await gateway.getAccountBalance("nonexistent")

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("LEDGER_ACCOUNT_NOT_FOUND")
    })
  })
})
