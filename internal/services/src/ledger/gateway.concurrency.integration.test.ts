import { sql } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../test-fixtures/database"
import { seedTestDb } from "../test-fixtures/seed-db"
import { WalletService } from "../wallet"
import { PLATFORM_FUNDING_KINDS, customerAccountKeys, platformAccountKey } from "./accounts"
import { LedgerGateway } from "./gateway"

const db = createTestDatabaseConnection()

const fixtures = ["base-project.sql", "customer-active.sql"]
const projectId = "proj_test"
const customerId = "cus_test"
const currency = "EUR"
const euro = 100_000_000

function createLogger(): Logger {
  return {
    set: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createLedger() {
  return new LedgerGateway({ db, logger: createLogger() })
}

async function listAccountNameCounts(prefix: string) {
  const result = await db.execute<{ count: number; name: string }>(sql`
    SELECT name, COUNT(*)::int AS count
    FROM pgledger_accounts_view
    WHERE name LIKE ${`${prefix}%`}
    GROUP BY name
    ORDER BY name
  `)

  return result.rows
}

async function expectNoDuplicateAccountBundle(input: {
  expectedNames: string[]
  prefix: string
}) {
  const rows = await listAccountNameCounts(input.prefix)
  expect(rows.map((row) => row.name).sort()).toEqual([...input.expectedNames].sort())
  expect(rows.map((row) => row.count)).toEqual(input.expectedNames.map(() => 1))
}

describe("LedgerGateway DB concurrency", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("seeds platform and customer account bundles once under concurrent first use", async () => {
    const platformAttempts = await Promise.all(
      Array.from({ length: 8 }, () => createLedger().seedPlatformAccounts(projectId, currency))
    )
    expect(platformAttempts.map((result) => result.err)).toEqual(Array(8).fill(undefined))

    await expectNoDuplicateAccountBundle({
      expectedNames: PLATFORM_FUNDING_KINDS.map((kind) => platformAccountKey(kind, projectId)),
      prefix: `platform.${projectId}.funding.`,
    })

    const customerAttempts = await Promise.all(
      Array.from({ length: 8 }, () => createLedger().ensureCustomerAccounts(customerId, currency))
    )
    expect(customerAttempts.map((result) => result.err)).toEqual(Array(8).fill(undefined))

    const keys = customerAccountKeys(customerId)
    await expectNoDuplicateAccountBundle({
      expectedNames: [keys.purchased, keys.granted, keys.reserved, keys.consumed, keys.receivable],
      prefix: `customer.${customerId}.`,
    })
  })

  it("keeps first wallet credit adjustment idempotent while creating accounts concurrently", async () => {
    const logger = createLogger()
    const wallet = new WalletService({
      db,
      logger,
      ledgerGateway: new LedgerGateway({ db, logger }),
    })

    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        wallet.adjust({
          actorId: "admin_1",
          currency,
          customerId,
          expiresAt: new Date("2026-02-01T00:00:00.000Z"),
          idempotencyKey: "ledger-first-use:wallet-adjust",
          projectId,
          reason: "parallel first credit",
          signedAmount: 5 * euro,
          source: "promo",
        })
      )
    )

    expect(attempts.map((result) => result.err)).toEqual(Array(6).fill(undefined))
    expect(new Set(attempts.map((result) => result.val?.grantId)).size).toBe(1)

    const keys = customerAccountKeys(customerId)
    await expectNoDuplicateAccountBundle({
      expectedNames: [keys.purchased, keys.granted, keys.reserved, keys.consumed, keys.receivable],
      prefix: `customer.${customerId}.`,
    })
    await expectNoDuplicateAccountBundle({
      expectedNames: PLATFORM_FUNDING_KINDS.map((kind) => platformAccountKey(kind, projectId)),
      prefix: `platform.${projectId}.funding.`,
    })

    const walletCredits = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM unprice_wallet_credits
      WHERE project_id = ${projectId}
        AND customer_id = ${customerId}
    `)
    expect(walletCredits.rows).toEqual([{ count: 1 }])

    const ledgerRows = await db.execute<{
      row_count: number
      source_type: string
      transfer_count: number
    }>(sql`
      SELECT source_type,
             COUNT(*)::int AS row_count,
             COUNT(DISTINCT transfer_id)::int AS transfer_count
      FROM unprice_ledger_idempotency
      WHERE project_id = ${projectId}
      GROUP BY source_type
    `)
    expect(ledgerRows.rows).toEqual([
      { row_count: 1, source_type: "wallet_adjust", transfer_count: 1 },
    ])
  })
})
