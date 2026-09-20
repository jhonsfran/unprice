import { entitlementReservations } from "@unprice/db/schema"
import type { Logger } from "@unprice/logs"
import { fromLedgerMinor, toLedgerMinor } from "@unprice/money"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../test-fixtures/database"
import { seedTestDb } from "../test-fixtures/seed-db"
import { customerAccountKeys, platformAccountKey } from "./accounts"
import { CustomerLedgerService } from "./customer-ledger-service"
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

function createCustomerLedger() {
  return new CustomerLedgerService({ db, logger: createLogger() })
}

/**
 * Fund `granted` from a platform account, hold part of it in `reserved`, then
 * settle part of the hold into `consumed` — one movement per step, each with a
 * different shape: platform→customer, customer→customer, customer→customer.
 */
async function seedCustomerLedger(ledger: LedgerGateway) {
  const keys = customerAccountKeys(customerId)

  await ledger.seedPlatformAccounts(projectId, currency)
  await ledger.ensureCustomerAccounts(customerId, currency)

  // the reservation the hold and its settlement both point at — the only
  // place the owning run is recorded for the capture leg
  await db.insert(entitlementReservations).values({
    id: "eres_1",
    projectId,
    customerId,
    ownerType: "agent_run",
    ownerId: "brun_1",
    allocationAmount: 4 * euro,
    refillChunkAmount: euro,
    periodStartAt: new Date("2026-09-01T00:00:00.000Z"),
    periodEndAt: new Date("2026-10-01T00:00:00.000Z"),
  })

  await ledger.createTransfer({
    projectId,
    fromAccount: platformAccountKey("promo", projectId),
    toAccount: keys.granted,
    amount: fromLedgerMinor(10 * euro, currency),
    source: { type: "wallet_adjust", id: "grant-1" },
    metadata: { flow: "adjust" },
    eventAt: new Date("2026-09-01T00:00:00.000Z"),
  })

  await ledger.createTransfer({
    projectId,
    fromAccount: keys.granted,
    toAccount: keys.reserved,
    amount: fromLedgerMinor(4 * euro, currency),
    source: { type: "wallet_reserve_granted", id: "reserve-1" },
    metadata: {
      flow: "reserve",
      reservation_id: "eres_1",
      reservation_owner_type: "agent_run",
      reservation_owner_id: "brun_1",
    },
    eventAt: new Date("2026-09-02T00:00:00.000Z"),
  })

  await ledger.createTransfer({
    projectId,
    fromAccount: keys.reserved,
    toAccount: keys.consumed,
    amount: fromLedgerMinor(3 * euro, currency),
    source: { type: "wallet_capture_usage", id: "capture-1" },
    statementKey: "stmt_1",
    metadata: { flow: "capture", kind: "usage", reservation_id: "eres_1" },
    eventAt: new Date("2026-09-03T00:00:00.000Z"),
  })

  return keys
}

describe("CustomerLedgerService.listCustomerTransfers", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("returns one row per transfer with both sides and both balances", async () => {
    const ledger = createLedger()
    const customerLedger = createCustomerLedger()
    const keys = await seedCustomerLedger(ledger)

    const result = await customerLedger.listCustomerTransfers({
      projectId,
      customerId,
      pageSize: 50,
    })

    expect(result.err).toBeUndefined()
    // three transfers, not the five postings they wrote
    expect(result.val?.total).toBe(3)

    const movements = result.val?.movements ?? []
    expect(movements.map((movement) => [movement.fromAccount, movement.toAccount])).toEqual([
      [keys.reserved, keys.consumed],
      [keys.granted, keys.reserved],
      [platformAccountKey("promo", projectId), keys.granted],
    ])
    // amounts are unsigned: direction lives in from/to
    expect(movements.map((movement) => toLedgerMinor(movement.amount))).toEqual([
      3 * euro,
      4 * euro,
      10 * euro,
    ])
    expect(movements.map((movement) => toLedgerMinor(movement.fromBalanceAfter))).toEqual([
      1 * euro,
      6 * euro,
      -10 * euro,
    ])
    expect(movements.map((movement) => toLedgerMinor(movement.toBalanceAfter))).toEqual([
      3 * euro,
      4 * euro,
      10 * euro,
    ])
    expect(movements.map((movement) => movement.sourceType)).toEqual([
      "wallet_capture_usage",
      "wallet_reserve_granted",
      "wallet_adjust",
    ])
    expect(movements.map((movement) => movement.statementKey)).toEqual(["stmt_1", null, null])
    expect(movements[1]?.metadata).toMatchObject({ reservation_owner_id: "brun_1" })
    // the capture carries no owner in metadata — it comes off the reservation
    expect(movements.map((movement) => movement.reservationOwnerId)).toEqual([
      "brun_1",
      "brun_1",
      null,
    ])
  })

  it("keeps a movement when either side touches the filtered account", async () => {
    const ledger = createLedger()
    const customerLedger = createCustomerLedger()
    await seedCustomerLedger(ledger)

    const reserved = await customerLedger.listCustomerTransfers({
      projectId,
      customerId,
      kinds: ["reserved"],
      pageSize: 50,
    })

    // the hold and its settlement both touch `reserved`, from opposite sides
    expect(reserved.val?.total).toBe(2)
    expect(reserved.val?.movements.map((movement) => movement.sourceType)).toEqual([
      "wallet_capture_usage",
      "wallet_reserve_granted",
    ])
  })

  it("filters by activity, by run id, and by event window", async () => {
    const ledger = createLedger()
    const customerLedger = createCustomerLedger()
    await seedCustomerLedger(ledger)

    const byFlow = await customerLedger.listCustomerTransfers({
      projectId,
      customerId,
      flows: ["adjust", "capture"],
      pageSize: 50,
    })
    expect(byFlow.val?.movements.map((movement) => movement.sourceType)).toEqual([
      "wallet_capture_usage",
      "wallet_adjust",
    ])

    // a run id only ever appears in metadata, never verbatim in the source id
    const byRun = await customerLedger.listCustomerTransfers({
      projectId,
      customerId,
      search: "brun_1",
      pageSize: 50,
    })
    // both legs of the run's reservation, not just the one holding the budget
    expect(byRun.val?.total).toBe(2)
    expect(byRun.val?.movements.map((movement) => movement.sourceType)).toEqual([
      "wallet_capture_usage",
      "wallet_reserve_granted",
    ])

    const byReservation = await customerLedger.listCustomerTransfers({
      projectId,
      customerId,
      search: "eres_1",
      pageSize: 50,
    })
    expect(byReservation.val?.total).toBe(2)

    const byWindow = await customerLedger.listCustomerTransfers({
      projectId,
      customerId,
      from: new Date("2026-09-02T00:00:00.000Z"),
      to: new Date("2026-09-02T23:59:59.000Z"),
      pageSize: 50,
    })
    expect(byWindow.val?.total).toBe(1)
    expect(byWindow.val?.movements[0]?.sourceType).toBe("wallet_reserve_granted")
  })

  it("orders backfilled movements by event time instead of insert time", async () => {
    const ledger = createLedger()
    const customerLedger = createCustomerLedger()
    const keys = await seedCustomerLedger(ledger)

    await ledger.createTransfer({
      projectId,
      fromAccount: platformAccountKey("promo", projectId),
      toAccount: keys.granted,
      amount: fromLedgerMinor(euro, currency),
      source: { type: "wallet_adjust", id: "backfill-1" },
      metadata: { flow: "adjust" },
      eventAt: new Date("2026-08-01T00:00:00.000Z"),
    })

    const result = await customerLedger.listCustomerTransfers({
      projectId,
      customerId,
      pageSize: 50,
    })

    expect(result.val?.movements.at(-1)?.sourceId).toBe("backfill-1")
  })

  it("paginates 1-based without repeating a movement", async () => {
    const ledger = createLedger()
    const customerLedger = createCustomerLedger()
    await seedCustomerLedger(ledger)

    const firstPage = await customerLedger.listCustomerTransfers({
      projectId,
      customerId,
      page: 1,
      pageSize: 2,
    })
    const secondPage = await customerLedger.listCustomerTransfers({
      projectId,
      customerId,
      page: 2,
      pageSize: 2,
    })

    expect(firstPage.val?.total).toBe(3)
    expect(firstPage.val?.movements).toHaveLength(2)
    expect(secondPage.val?.movements).toHaveLength(1)
    expect(
      firstPage.val?.movements.some((movement) => movement.id === secondPage.val?.movements[0]?.id)
    ).toBe(false)
  })

  it("never returns another customer's movements", async () => {
    const ledger = createLedger()
    const customerLedger = createCustomerLedger()
    await seedCustomerLedger(ledger)

    const result = await customerLedger.listCustomerTransfers({
      projectId,
      customerId: "cus_someone_else",
      pageSize: 50,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({ movements: [], total: 0 })
  })
})
