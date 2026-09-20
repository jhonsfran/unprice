import type { Customer } from "@unprice/db/validators"
import { Err, FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { fromLedgerMinor } from "@unprice/money"
import { describe, expect, it, vi } from "vitest"
import type { CustomerService } from "../../customers/service"
import type { CustomerLedgerMovement, CustomerLedgerService } from "../../ledger"
import { customerAccountKeys, platformAccountKey } from "../../ledger"
import { getCustomerLedger } from "./get-customer-ledger"

const projectId = "proj_123"
const customerId = "cus_123"
const keys = customerAccountKeys(customerId)

describe("getCustomerLedger", () => {
  it("labels both sides, direction, and the balance the reader is tracking", async () => {
    const ledger = createLedger([
      // a hold: spendable money leaves `granted` for `reserved`
      createMovement({
        id: "pglt_reserve",
        fromAccount: keys.granted,
        toAccount: keys.reserved,
        amount: 10_000_000,
        fromBalanceAfter: 90_000_000,
        toBalanceAfter: 10_000_000,
        metadata: {
          flow: "reserve",
          reservation_id: "eres_1",
          reservation_owner_type: "agent_run",
          reservation_owner_id: "brun_1",
        },
      }),
      // a grant: money arrives from a platform funding account
      createMovement({
        id: "pglt_grant",
        fromAccount: platformAccountKey("promo", projectId),
        toAccount: keys.granted,
        amount: 100_000_000,
        fromBalanceAfter: -100_000_000,
        toBalanceAfter: 100_000_000,
        metadata: { flow: "adjust" },
      }),
    ])

    const result = await run({ ledger })

    expect(result.err).toBeUndefined()
    expect(result.val?.movements[0]).toMatchObject({
      id: "pglt_reserve",
      flow: "reserve",
      from: { side: "customer", account: "granted" },
      to: { side: "customer", account: "reserved" },
      amount: 10_000_000,
      direction: "out",
      // money left `granted`, so `granted` is the balance worth showing
      balanceAfter: { account: "granted", amount: 90_000_000 },
      runId: "brun_1",
      reservationId: "eres_1",
    })
    expect(result.val?.movements[1]).toMatchObject({
      id: "pglt_grant",
      from: { side: "platform", funding: "promo" },
      to: { side: "customer", account: "granted" },
      direction: "in",
      balanceAfter: { account: "granted", amount: 100_000_000 },
      runId: null,
    })
  })

  it("treats a settled hold as internal and still names the run behind it", async () => {
    const ledger = createLedger([
      createMovement({
        fromAccount: keys.reserved,
        toAccount: keys.consumed,
        amount: 10_000_000,
        fromBalanceAfter: 0,
        toBalanceAfter: 10_000_000,
        // capture metadata has no owner; the gateway resolved it from the
        // reservation row so this leg can name the run too
        metadata: { flow: "capture", reservation_id: "eres_1" },
        reservationOwnerType: "agent_run",
        reservationOwnerId: "brun_1",
      }),
    ])

    const result = await run({ ledger })

    expect(result.val?.movements[0]).toMatchObject({
      direction: "internal",
      balanceAfter: { account: "consumed", amount: 10_000_000 },
      reservationId: "eres_1",
      runId: "brun_1",
    })
  })

  it("ignores a reservation owner that is not an agent run", async () => {
    const ledger = createLedger([
      createMovement({
        metadata: { flow: "reserve", reservation_id: "eres_1" },
        reservationOwnerType: "entitlement_window",
        reservationOwnerId: "ent_1",
      }),
    ])

    const result = await run({ ledger })

    expect(result.val?.movements[0]).toMatchObject({ runId: null, reservationId: "eres_1" })
  })

  it("falls back to the gateway source type when a transfer carries no flow", async () => {
    const ledger = createLedger([
      createMovement({
        fromAccount: keys.granted,
        toAccount: "customer.cus_123.some_future_account",
        metadata: null,
        sourceType: "wallet_unknown_future",
      }),
    ])

    const result = await run({ ledger })

    expect(result.val?.movements[0]).toMatchObject({
      flow: "wallet_unknown_future",
      to: { side: "external", name: "customer.cus_123.some_future_account" },
      direction: "out",
      balanceAfter: { account: "granted", amount: 0 },
    })
  })

  it("passes only known account and activity filters through to the gateway", async () => {
    const ledger = createLedger([])

    await run({
      ledger,
      input: {
        from: 1_720_000_000_000,
        to: 1_720_086_400_000,
        filters: {
          account: ["granted", "not_an_account", "reserved"],
          activity: ["reserve", "not_an_activity"],
        },
      },
    })

    expect(ledger.listCustomerTransfers).toHaveBeenCalledWith({
      projectId,
      customerId,
      kinds: ["granted", "reserved"],
      flows: ["reserve"],
      search: null,
      from: new Date(1_720_000_000_000),
      to: new Date(1_720_086_400_000),
      page: 1,
      pageSize: 10,
    })
  })

  it("drops a filter entirely when no value is recognized", async () => {
    const ledger = createLedger([])

    await run({ ledger, input: { filters: { account: ["nope"], activity: ["nope"] } } })

    expect(ledger.listCustomerTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: undefined, flows: undefined })
    )
  })

  it("returns null when the customer does not belong to the project", async () => {
    const ledger = createLedger([])
    const result = await run({
      ledger,
      customers: { getCustomerByIdInProject: vi.fn().mockResolvedValue(Ok(null)) },
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toBeNull()
    expect(ledger.listCustomerTransfers).not.toHaveBeenCalled()
  })

  it("propagates customer lookup failures", async () => {
    const result = await run({
      ledger: createLedger([]),
      customers: {
        getCustomerByIdInProject: vi
          .fn()
          .mockResolvedValue(Err(new FetchError({ message: "boom", retry: false }))),
      },
    })

    expect(result.err).toBeDefined()
    expect(result.val).toBeUndefined()
  })
})

function createLedger(movements: CustomerLedgerMovement[], total = movements.length) {
  return {
    listCustomerTransfers: vi.fn().mockResolvedValue(Ok({ movements, total })),
  }
}

async function run(opts: {
  ledger: { listCustomerTransfers: ReturnType<typeof vi.fn> }
  customers?: { getCustomerByIdInProject: ReturnType<typeof vi.fn> }
  input?: Partial<Parameters<typeof getCustomerLedger>[1]>
}) {
  const customers = opts.customers ?? {
    getCustomerByIdInProject: vi.fn().mockResolvedValue(Ok(createCustomer())),
  }

  return getCustomerLedger(
    {
      services: {
        customers: customers as unknown as CustomerService,
        customerLedger: opts.ledger as unknown as CustomerLedgerService,
      },
      logger: createLogger(),
    },
    {
      projectId,
      customerId,
      page: 1,
      page_size: 10,
      search: null,
      from: null,
      to: null,
      filters: {},
      ...opts.input,
    }
  )
}

function createCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: customerId,
    projectId,
    email: "billing@example.com",
    name: "Example Customer",
    description: "Customer with ledger activity",
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

type MovementOverrides = Omit<
  Partial<CustomerLedgerMovement>,
  "amount" | "fromBalanceAfter" | "toBalanceAfter"
> & {
  // minor units in the fixture; converted to Dinero the way the gateway does
  amount?: number
  fromBalanceAfter?: number
  toBalanceAfter?: number
}

function createMovement({
  amount = 0,
  fromBalanceAfter = 0,
  toBalanceAfter = 0,
  ...overrides
}: MovementOverrides = {}): CustomerLedgerMovement {
  return {
    id: "pglt_1",
    fromAccount: keys.granted,
    toAccount: keys.reserved,
    currency: "USD",
    sourceType: "wallet_reserve_granted",
    sourceId: "src_1",
    statementKey: null,
    reservationOwnerType: null,
    reservationOwnerId: null,
    metadata: null,
    createdAt: new Date("2026-09-20T00:00:00.000Z"),
    eventAt: new Date("2026-09-20T00:00:00.000Z"),
    amount: fromLedgerMinor(amount, "USD"),
    fromBalanceAfter: fromLedgerMinor(fromBalanceAfter, "USD"),
    toBalanceAfter: fromLedgerMinor(toBalanceAfter, "USD"),
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
