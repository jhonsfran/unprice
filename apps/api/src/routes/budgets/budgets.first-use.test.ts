import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { balance, createBudgetTestFixture, usd } from "./budgets.fixture"

const mocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
  execute: vi.fn(),
  log: vi.fn(),
  recordCatalog: vi.fn(),
}))

vi.mock("~/auth/key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/auth/key")>()),
  keyAuth: mocks.keyAuth,
}))

vi.mock("~/ingestion/budget/client", () => ({
  CloudflareBudgetClient: class {
    execute = mocks.execute
  },
}))

const { call } = createBudgetTestFixture(mocks)

describe("budgets API", () => {
  it("records a created budget in the catalog for the authenticated project", async () => {
    mocks.execute.mockResolvedValue(
      Ok({
        type: "upsert",
        changes: [{ change: "limit.added", limitId: "month" }],
        budget: {
          key: "customer:acme",
          unit: "money:USD",
          version: 1,
          limits: [{ id: "month", amount: usd(50), window: "month", enforce: "soft" }],
          holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
          onUnavailable: "deny",
          closesAt: null,
          closed: false,
          balance: balance(usd(50)),
          operations: { upsert: 1, authorize: 0, settle: 0, release: 0, charge: 0, record: 0 },
        },
      })
    )

    const response = await call("/v1/budgets/upsert", {
      key: "customer:acme",
      unit: "USD",
      limits: [{ amount: "50", window: "month", enforce: "soft" }],
    })

    expect(response.status).toBe(200)
    expect(mocks.recordCatalog.mock.calls).toEqual([
      [
        "proj_123",
        {
          key: "customer:acme",
          unit: "money:USD",
          version: 1,
          cap: "soft",
          limits: [{ id: "month", window: "month", enforce: "soft", amount: "50" }],
          closesAt: null,
        },
      ],
    ])
  })
})

describe("budgets created on first use", () => {
  const snapshot = {
    key: "customer:acme",
    unit: "money:USD",
    version: 1,
    limits: [{ id: "month", amount: usd(5), window: "month", enforce: "hard" }],
    holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
    onUnavailable: "deny",
    closesAt: null,
    closed: false,
    balance: balance(usd(4), usd(1)),
    operations: { upsert: 0, authorize: 1, settle: 0, release: 0, charge: 0, record: 0 },
  }
  const ifMissing = { unit: "USD", limits: [{ amount: "5", window: "month" }] }

  it("sends the definition to the budget with the address and records the created budget", async () => {
    mocks.execute.mockResolvedValue(
      Ok({
        type: "authorize",
        holdId: "h_1",
        amount: usd(1),
        expiresAt: 1_796_083_260_000,
        replayed: false,
        created: snapshot,
        balance: balance(usd(4), usd(1)),
      })
    )
    const response = await call("/v1/budgets/authorize", {
      key: "customer:acme",
      amount: "1",
      idempotencyKey: "a1",
      ifMissing,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ allowed: true, holdId: "h_1", created: true })
    expect(mocks.execute.mock.calls[0]).toEqual([
      { projectId: "proj_123", key: "customer:acme" },
      {
        type: "authorize",
        amount: usd(1),
        idempotencyKey: "a1",
        ifMissing: {
          key: "customer:acme",
          projectId: "proj_123",
          unit: "money:USD",
          config: {
            limits: [{ id: "month", amount: usd(5), window: "month", enforce: "hard" }],
            holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 },
            onUnavailable: "deny",
            closesAt: null,
          },
        },
      },
    ])
    expect(mocks.recordCatalog.mock.calls).toEqual([
      [
        "proj_123",
        {
          key: "customer:acme",
          unit: "money:USD",
          version: 1,
          cap: "hard",
          limits: [{ id: "month", window: "month", enforce: "hard", amount: "5" }],
          closesAt: null,
        },
      ],
    ])
  })

  it("answers created: false and records nothing when the budget already existed", async () => {
    mocks.execute.mockResolvedValue(
      Ok({
        type: "charge",
        amount: usd(1),
        crossed: [],
        replayed: false,
        created: null,
        balance: balance(usd(4)),
      })
    )
    const response = await call("/v1/budgets/charge", {
      key: "customer:acme",
      amount: "1",
      idempotencyKey: "c1",
      ifMissing,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ allowed: true, created: false })
    expect(mocks.recordCatalog).not.toHaveBeenCalled()
  })

  it("returns 400 for a definition the boundary rejects", async () => {
    const response = await call("/v1/budgets/authorize", {
      key: "customer:acme",
      amount: "1",
      idempotencyKey: "a1",
      ifMissing: {
        unit: "USD",
        limits: [
          { amount: "5", window: "month" },
          { amount: "6", window: "month" },
        ],
      },
    })
    expect(response.status).toBe(400)
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it("sends the definition with a lease", async () => {
    mocks.execute.mockResolvedValue(
      Ok({
        type: "lease",
        lease: {
          leaseKey: "l1",
          seq: 0,
          granted: usd(1),
          captured: usd(0),
          expiresAt: 1_796_083_260_000,
          status: "open",
        },
        terms: { holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 }, closesAt: null },
        replayed: false,
        created: snapshot,
        balance: balance(usd(4), usd(1)),
      })
    )
    const response = await call("/v1/budgets/lease", {
      key: "customer:acme",
      leaseKey: "l1",
      amount: "1",
      ttlMs: 60_000,
      ifMissing,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ created: true })
    expect(mocks.execute.mock.calls[0]?.[1]).toMatchObject({
      type: "lease",
      ifMissing: { key: "customer:acme", projectId: "proj_123" },
    })
    expect(mocks.recordCatalog).toHaveBeenCalledTimes(1)
  })
})
