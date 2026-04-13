import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Metrics } from "../metrics"
import { InMemoryLedgerRepository } from "./repository.memory"
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
  let repo: InMemoryLedgerRepository
  let mockLogger: Logger

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new InMemoryLedgerRepository()

    mockLogger = {
      set: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    } as unknown as Logger

    service = new LedgerService({
      repo,
      logger: mockLogger,
      metrics: {} as Metrics,
    })
  })

  describe("postDebit / postCredit", () => {
    it("posts a debit entry successfully", async () => {
      const result = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test_charge",
        sourceId: "charge_1",
        now: 1000000,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toBeDefined()
      expect(result.val!.entryType).toBe("debit")
      expect(result.val!.amountMinor).toBe(BigInt(1_000_000))
      expect(result.val!.signedAmountMinor).toBe(BigInt(1_000_000))
    })

    it("posts a credit entry with negative signed amount", async () => {
      const result = await service.postCredit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(500_000),
        sourceType: "test_refund",
        sourceId: "refund_1",
        now: 1000000,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toBeDefined()
      expect(result.val!.entryType).toBe("credit")
      expect(result.val!.amountMinor).toBe(BigInt(500_000))
      expect(result.val!.signedAmountMinor).toBe(BigInt(-500_000))
    })

    it("rejects zero amount", async () => {
      const result = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(0),
        sourceType: "test",
        sourceId: "bad_zero",
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("LEDGER_INVALID_AMOUNT")
    })

    it("rejects negative amounts", async () => {
      const result = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(-100),
        sourceType: "test",
        sourceId: "bad_1",
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("LEDGER_INVALID_AMOUNT")
    })

    it("rejects missing source identity", async () => {
      const result = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(100),
        sourceType: "",
        sourceId: "x",
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("LEDGER_SOURCE_IDENTITY_REQUIRED")
    })

    it("preserves sub-cent precision with bigint amounts", async () => {
      const result = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1),
        sourceType: "test_subcent",
        sourceId: "subcent_1",
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.amountMinor).toBe(BigInt(1))
    })

    it("updates ledger balance after posting", async () => {
      await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(3_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      const ledger = await repo.findLedger({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
      })
      expect(ledger).not.toBeNull()
      expect(ledger!.balanceMinor).toBe(BigInt(3_000_000))
    })
  })

  describe("idempotency", () => {
    it("returns existing entry on duplicate sourceType + sourceId", async () => {
      const input = {
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD" as const,
        amountMinor: BigInt(1_000_000),
        sourceType: "subscription_billing_period_charge_v1",
        sourceId: "bp_1:si_1",
        now: 1000000,
      }

      const first = await service.postDebit(input)
      expect(first.err).toBeUndefined()

      const second = await service.postDebit(input)
      expect(second.err).toBeUndefined()
      expect(second.val!.sourceType).toBe(input.sourceType)
      expect(second.val!.sourceId).toBe(input.sourceId)
      expect(second.val!.id).toBe(first.val!.id)
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
      await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        statementKey: "stmt_1",
        metadata: { subscriptionId: "sub_1" },
        now: 1000,
      })

      await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(2_000_000),
        sourceType: "test",
        sourceId: "s2",
        statementKey: "stmt_2",
        metadata: { subscriptionId: "sub_2" },
        now: 2000,
      })

      const result = await service.getUnsettledEntries({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        statementKey: "stmt_1",
        subscriptionId: "sub_1",
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.length).toBe(1)
      expect(result.val![0]!.metadata?.subscriptionId).toBe("sub_1")
    })

    it("excludes settled entries", async () => {
      const debit = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      await service.settleEntries({
        projectId: "proj_1",
        entryIds: [debit.val!.id],
        type: "invoice",
        artifactId: "inv_1",
        now: 2000,
      })

      const result = await service.getUnsettledEntries({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toEqual([])
    })
  })

  describe("getUnsettledBalance", () => {
    it("returns BigInt(0) when no entries exist", async () => {
      const result = await service.getUnsettledBalance({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toBe(BigInt(0))
    })

    it("returns computed sum of unsettled entry signedAmountMinor", async () => {
      await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(2_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s2",
        now: 2000,
      })

      const result = await service.getUnsettledBalance({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toBe(BigInt(3_000_000))
    })
  })

  describe("settleEntries", () => {
    it("returns error for empty entryIds", async () => {
      const result = await service.settleEntries({
        projectId: "proj_1",
        entryIds: [],
        type: "invoice",
        artifactId: "inv_1",
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("SETTLEMENT_CREATE_FAILED")
    })

    it("creates a pending settlement for valid entries", async () => {
      const debit = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      const result = await service.settleEntries({
        projectId: "proj_1",
        entryIds: [debit.val!.id],
        type: "invoice",
        artifactId: "inv_1",
        now: 2000,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toBeDefined()
      expect(result.val!.status).toBe("pending")
      expect(result.val!.artifactId).toBe("inv_1")
      expect(result.val!.type).toBe("invoice")
    })

    it("rejects entries from different ledgers", async () => {
      const debit1 = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      const debit2 = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_2",
        currency: "USD",
        amountMinor: BigInt(500_000),
        sourceType: "test",
        sourceId: "s2",
        now: 1000,
      })

      const result = await service.settleEntries({
        projectId: "proj_1",
        entryIds: [debit1.val!.id, debit2.val!.id],
        type: "invoice",
        artifactId: "inv_1",
        now: 2000,
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("ENTRIES_MIXED_LEDGERS")
    })
  })

  describe("confirmSettlement", () => {
    it("transitions pending to confirmed", async () => {
      const debit = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      await service.settleEntries({
        projectId: "proj_1",
        entryIds: [debit.val!.id],
        type: "invoice",
        artifactId: "inv_1",
        now: 1500,
      })

      const result = await service.confirmSettlement({
        projectId: "proj_1",
        artifactId: "inv_1",
        type: "invoice",
        now: 2000,
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.status).toBe("confirmed")
      expect(result.val!.artifactId).toBe("inv_1")
    })

    it("returns error when settlement not found", async () => {
      const result = await service.confirmSettlement({
        projectId: "proj_1",
        artifactId: "inv_missing",
        type: "invoice",
        now: 2000,
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("SETTLEMENT_NOT_FOUND")
    })

    it("rejects confirming an already-confirmed settlement", async () => {
      const debit = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      await service.settleEntries({
        projectId: "proj_1",
        entryIds: [debit.val!.id],
        type: "invoice",
        artifactId: "inv_1",
        now: 1500,
      })

      await service.confirmSettlement({
        projectId: "proj_1",
        artifactId: "inv_1",
        type: "invoice",
        now: 2000,
      })

      const result = await service.confirmSettlement({
        projectId: "proj_1",
        artifactId: "inv_1",
        type: "invoice",
        now: 3000,
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("SETTLEMENT_INVALID_TRANSITION")
    })
  })

  describe("reverseSettlement", () => {
    it("creates opposite-signed reversal entries and updates balance", async () => {
      const debit = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(3_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      await service.settleEntries({
        projectId: "proj_1",
        entryIds: [debit.val!.id],
        type: "invoice",
        artifactId: "inv_1",
        now: 1500,
      })

      const result = await service.reverseSettlement({
        projectId: "proj_1",
        artifactId: "inv_1",
        type: "invoice",
        reason: "payment failed",
        now: 2000,
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.settlement.status).toBe("reversed")
      expect(result.val!.settlement.reversalReason).toBe("payment failed")
      expect(result.val!.reversalEntries.length).toBe(1)

      const reversal = result.val!.reversalEntries[0]!
      expect(reversal.entryType).toBe("credit")
      expect(reversal.signedAmountMinor).toBe(BigInt(-3_000_000))
      expect(reversal.amountMinor).toBe(BigInt(3_000_000))
      expect(reversal.sourceType).toBe("reversal_v1")
      expect(reversal.metadata?.reversalOf).toBe(debit.val!.id)
      expect(reversal.metadata?.reason).toBe("payment failed")
      expect(reversal.metadata?.invoiceItemKind).toBe("refund")

      // balance should be back to 0
      const ledger = await repo.findLedger({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
      })
      expect(ledger!.balanceMinor).toBe(BigInt(0))
    })

    it("reverses multiple entries in a settlement", async () => {
      const d1 = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      const d2 = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(2_000_000),
        sourceType: "test",
        sourceId: "s2",
        now: 1001,
      })

      await service.settleEntries({
        projectId: "proj_1",
        entryIds: [d1.val!.id, d2.val!.id],
        type: "invoice",
        artifactId: "inv_1",
        now: 1500,
      })

      const result = await service.reverseSettlement({
        projectId: "proj_1",
        artifactId: "inv_1",
        type: "invoice",
        reason: "chargeback",
        now: 2000,
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.reversalEntries.length).toBe(2)

      const totalReversed = result.val!.reversalEntries.reduce(
        (sum, e) => sum + e.signedAmountMinor,
        BigInt(0)
      )
      expect(totalReversed).toBe(BigInt(-3_000_000))

      const ledger = await repo.findLedger({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
      })
      expect(ledger!.balanceMinor).toBe(BigInt(0))
    })

    it("allows reversing a confirmed settlement (chargeback)", async () => {
      const debit = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      await service.settleEntries({
        projectId: "proj_1",
        entryIds: [debit.val!.id],
        type: "invoice",
        artifactId: "inv_1",
        now: 1500,
      })

      await service.confirmSettlement({
        projectId: "proj_1",
        artifactId: "inv_1",
        type: "invoice",
        now: 1700,
      })

      const result = await service.reverseSettlement({
        projectId: "proj_1",
        artifactId: "inv_1",
        type: "invoice",
        reason: "chargeback by customer",
        now: 2000,
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.settlement.status).toBe("reversed")
    })

    it("rejects reversing an already-reversed settlement", async () => {
      const debit = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      await service.settleEntries({
        projectId: "proj_1",
        entryIds: [debit.val!.id],
        type: "invoice",
        artifactId: "inv_1",
        now: 1500,
      })

      await service.reverseSettlement({
        projectId: "proj_1",
        artifactId: "inv_1",
        type: "invoice",
        reason: "first reversal",
        now: 2000,
      })

      const result = await service.reverseSettlement({
        projectId: "proj_1",
        artifactId: "inv_1",
        type: "invoice",
        reason: "duplicate reversal",
        now: 3000,
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("SETTLEMENT_INVALID_TRANSITION")
    })

    it("returns error when settlement not found", async () => {
      const result = await service.reverseSettlement({
        projectId: "proj_1",
        artifactId: "inv_missing",
        type: "invoice",
        reason: "test",
        now: 2000,
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("SETTLEMENT_NOT_FOUND")
    })

    it("reversal entries are idempotent — re-reversing same settlement does not double-post", async () => {
      const debit = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      await service.settleEntries({
        projectId: "proj_1",
        entryIds: [debit.val!.id],
        type: "invoice",
        artifactId: "inv_1",
        now: 1500,
      })

      const first = await service.reverseSettlement({
        projectId: "proj_1",
        artifactId: "inv_1",
        type: "invoice",
        reason: "payment failed",
        now: 2000,
      })

      expect(first.err).toBeUndefined()
      expect(first.val!.reversalEntries.length).toBe(1)

      // total entries: 1 original debit + 1 reversal = 2
      expect(repo.entries.size).toBe(2)

      // Attempting a second reversal must fail (settlement is already reversed).
      const second = await service.reverseSettlement({
        projectId: "proj_1",
        artifactId: "inv_1",
        type: "invoice",
        reason: "duplicate attempt",
        now: 3000,
      })

      expect(second.err).toBeDefined()
      expect(second.err!.message).toBe("SETTLEMENT_INVALID_TRANSITION")

      // Entry count unchanged — no spurious reversal entries created.
      expect(repo.entries.size).toBe(2)

      // Balance is still restored to 0 from the first reversal.
      const ledger = await repo.findLedger({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
      })
      expect(ledger!.balanceMinor).toBe(BigInt(0))
    })
  })

  describe("partial settlement", () => {
    it("settles a subset of entries and leaves the rest unsettled", async () => {
      const d1 = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      const d2 = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(2_000_000),
        sourceType: "test",
        sourceId: "s2",
        now: 1001,
      })

      const d3 = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(3_000_000),
        sourceType: "test",
        sourceId: "s3",
        now: 1002,
      })

      // Settle only the first entry
      const result = await service.settleEntries({
        projectId: "proj_1",
        entryIds: [d1.val!.id],
        type: "invoice",
        artifactId: "inv_partial",
        now: 2000,
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.status).toBe("pending")

      // Entries d2 and d3 remain unsettled
      const unsettled = await service.getUnsettledEntries({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
      })

      expect(unsettled.err).toBeUndefined()
      expect(unsettled.val!.length).toBe(2)
      const unsettledIds = unsettled.val!.map((e) => e.id).sort()
      expect(unsettledIds).toEqual([d2.val!.id, d3.val!.id].sort())
    })

    it("allows settling remaining entries in a second settlement", async () => {
      const d1 = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      const d2 = await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(2_000_000),
        sourceType: "test",
        sourceId: "s2",
        now: 1001,
      })

      // First settlement: d1 only
      await service.settleEntries({
        projectId: "proj_1",
        entryIds: [d1.val!.id],
        type: "invoice",
        artifactId: "inv_1",
        now: 2000,
      })

      // Second settlement: d2
      const result = await service.settleEntries({
        projectId: "proj_1",
        entryIds: [d2.val!.id],
        type: "invoice",
        artifactId: "inv_2",
        now: 2001,
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.artifactId).toBe("inv_2")

      // All entries are now settled
      const unsettled = await service.getUnsettledEntries({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
      })

      expect(unsettled.err).toBeUndefined()
      expect(unsettled.val!.length).toBe(0)
    })
  })

  describe("settleJournal", () => {
    it("settles all entries in a journal", async () => {
      const journalId = "journal_1"

      await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        journalId,
        now: 1000,
      })

      await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(500_000),
        sourceType: "test",
        sourceId: "s2",
        journalId,
        now: 1001,
      })

      const result = await service.settleJournal({
        projectId: "proj_1",
        journalId,
        type: "invoice",
        artifactId: "inv_1",
        now: 2000,
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.status).toBe("pending")
      expect(result.val!.type).toBe("invoice")
    })
  })

  describe("getEntriesByJournal", () => {
    it("returns entries matching the journal", async () => {
      await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(1_000_000),
        sourceType: "test",
        sourceId: "s1",
        journalId: "j1",
        now: 1000,
      })

      await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(500_000),
        sourceType: "test",
        sourceId: "s2",
        journalId: "j2",
        now: 1001,
      })

      const result = await service.getEntriesByJournal({
        projectId: "proj_1",
        journalId: "j1",
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.length).toBe(1)
      expect(result.val![0]!.sourceId).toBe("s1")
    })
  })

  describe("reconcileBalance", () => {
    it("detects and corrects balance drift", async () => {
      await service.postDebit({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
        amountMinor: BigInt(5_000_000),
        sourceType: "test",
        sourceId: "s1",
        now: 1000,
      })

      const ledger = await repo.findLedger({
        projectId: "proj_1",
        customerId: "cust_1",
        currency: "USD",
      })

      await repo.updateLedgerBalance({
        projectId: "proj_1",
        ledgerId: ledger!.id,
        balanceMinor: BigInt(999),
        updatedAtM: 2000,
      })

      const result = await service.reconcileBalance({
        projectId: "proj_1",
        ledgerId: ledger!.id,
      })

      expect(result.err).toBeUndefined()
      expect(result.val!.cached).toBe(BigInt(999))
      expect(result.val!.computed).toBe(BigInt(5_000_000))

      const fixed = await repo.findLedgerById({
        projectId: "proj_1",
        ledgerId: ledger!.id,
      })
      expect(fixed!.balanceMinor).toBe(BigInt(5_000_000))
    })

    it("returns error for non-existent ledger", async () => {
      const result = await service.reconcileBalance({
        projectId: "proj_1",
        ledgerId: "ldg_nonexistent",
      })

      expect(result.err).toBeDefined()
      expect(result.err!.message).toBe("LEDGER_NOT_FOUND")
    })
  })
})
