import type { Logger } from "@unprice/logs"
import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import type { Metrics } from "../metrics"
import { decideCredit, decideDebit, foldLedgerState, foldSettlementState } from "./core"
import { InMemoryLedgerRepository } from "./repository.memory"
import { LedgerService } from "./service"
import type { LedgerEntryForFold, LedgerState } from "./types"

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

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Positive bigint amount (1..10^12) for ledger entries. */
const amountArb = fc.bigInt({ min: BigInt(1), max: BigInt(1_000_000_000_000) })

/** A signed entry for fold: positive (debit) or negative (credit). */
const signedEntryArb: fc.Arbitrary<LedgerEntryForFold> = amountArb.chain((amount) =>
  fc.boolean().map((isDebit) => ({
    signedAmountMinor: isDebit ? amount : -amount,
  }))
)

/** Non-empty list of signed entries. */
const entryListArb = fc.array(signedEntryArb, { minLength: 1, maxLength: 200 })

// ---------------------------------------------------------------------------
// Pure core invariants
// ---------------------------------------------------------------------------

describe("property: foldLedgerState", () => {
  it("balance equals sum of all signedAmountMinor", () => {
    fc.assert(
      fc.property(entryListArb, (entries) => {
        const state = foldLedgerState(entries)
        const expectedBalance = entries.reduce((sum, e) => sum + e.signedAmountMinor, BigInt(0))
        expect(state.balanceMinor).toBe(expectedBalance)
        expect(state.entryCount).toBe(entries.length)
      }),
      { numRuns: 500 }
    )
  })

  it("folding is associative — splitting and merging yields same result", () => {
    fc.assert(
      fc.property(entryListArb, fc.integer({ min: 0 }), (entries, splitRaw) => {
        const splitAt = splitRaw % (entries.length + 1)
        const left = entries.slice(0, splitAt)
        const right = entries.slice(splitAt)

        const stateAll = foldLedgerState(entries)
        const stateLeft = foldLedgerState(left)
        const stateRight = foldLedgerState(right)

        expect(stateAll.balanceMinor).toBe(stateLeft.balanceMinor + stateRight.balanceMinor)
        expect(stateAll.entryCount).toBe(stateLeft.entryCount + stateRight.entryCount)
      }),
      { numRuns: 300 }
    )
  })

  it("empty fold is identity", () => {
    const state = foldLedgerState([])
    expect(state.balanceMinor).toBe(BigInt(0))
    expect(state.entryCount).toBe(0)
  })
})

describe("property: decideDebit / decideCredit", () => {
  it("debit always increases balance", () => {
    fc.assert(
      fc.property(amountArb, amountArb, (balance, amount) => {
        const state: LedgerState = { balanceMinor: balance, entryCount: 1 }
        const result = decideDebit({ amountMinor: amount }, state)
        expect(result.err).toBeUndefined()
        expect(result.val!.balanceAfterMinor).toBe(balance + amount)
        expect(result.val!.signedAmountMinor).toBe(amount)
      }),
      { numRuns: 500 }
    )
  })

  it("credit always decreases balance", () => {
    fc.assert(
      fc.property(amountArb, amountArb, (balance, amount) => {
        const state: LedgerState = { balanceMinor: balance, entryCount: 1 }
        const result = decideCredit({ amountMinor: amount }, state)
        expect(result.err).toBeUndefined()
        expect(result.val!.balanceAfterMinor).toBe(balance - amount)
        expect(result.val!.signedAmountMinor).toBe(-amount)
      }),
      { numRuns: 500 }
    )
  })

  it("debit followed by credit of same amount restores balance", () => {
    fc.assert(
      fc.property(amountArb, amountArb, (balance, amount) => {
        const state: LedgerState = { balanceMinor: balance, entryCount: 0 }
        const debitResult = decideDebit({ amountMinor: amount }, state)
        expect(debitResult.err).toBeUndefined()

        const afterDebit: LedgerState = {
          balanceMinor: debitResult.val!.balanceAfterMinor,
          entryCount: 1,
        }
        const creditResult = decideCredit({ amountMinor: amount }, afterDebit)
        expect(creditResult.err).toBeUndefined()
        expect(creditResult.val!.balanceAfterMinor).toBe(balance)
      }),
      { numRuns: 500 }
    )
  })
})

describe("property: foldSettlementState", () => {
  it("totalSettledMinor equals sum of line amounts", () => {
    const lineArb = fc.array(
      amountArb.map((a) => ({ amountMinor: a })),
      { minLength: 0, maxLength: 50 }
    )

    fc.assert(
      fc.property(lineArb, (lines) => {
        const settlement = {
          id: "lset_test",
          status: "pending",
          type: "invoice",
          confirmedAt: null,
          reversedAt: null,
          reversalReason: null,
        }
        const state = foldSettlementState(settlement, lines)
        const expected = lines.reduce((sum, l) => sum + l.amountMinor, BigInt(0))
        expect(state.totalSettledMinor).toBe(expected)
        expect(state.lineCount).toBe(lines.length)
      }),
      { numRuns: 300 }
    )
  })
})

// ---------------------------------------------------------------------------
// Service-level invariants (integration with InMemoryRepository)
// ---------------------------------------------------------------------------

describe("property: LedgerService balance invariant", () => {
  const mockLogger: Logger = {
    set: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger

  it("ledger balance equals sum of all entries after random debit/credit sequence", () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            isDebit: fc.boolean(),
            amount: amountArb,
          }),
          { minLength: 1, maxLength: 50 }
        ),
        async (operations) => {
          const repo = new InMemoryLedgerRepository()
          const service = new LedgerService({
            repo,
            logger: mockLogger,
            metrics: {} as Metrics,
          })

          let expectedBalance = BigInt(0)

          for (let i = 0; i < operations.length; i++) {
            const op = operations[i]!
            if (op.isDebit) {
              const result = await service.postDebit({
                projectId: "proj_1",
                customerId: "cust_1",
                currency: "USD",
                amountMinor: op.amount,
                sourceType: "prop_test",
                sourceId: `op_${i}`,
                now: 1000 + i,
              })
              expect(result.err).toBeUndefined()
              expectedBalance += op.amount
            } else {
              const result = await service.postCredit({
                projectId: "proj_1",
                customerId: "cust_1",
                currency: "USD",
                amountMinor: op.amount,
                sourceType: "prop_test",
                sourceId: `op_${i}`,
                now: 1000 + i,
              })
              expect(result.err).toBeUndefined()
              expectedBalance -= op.amount
            }
          }

          const ledger = await repo.findLedger({
            projectId: "proj_1",
            customerId: "cust_1",
            currency: "USD",
          })
          expect(ledger).not.toBeNull()
          expect(ledger!.balanceMinor).toBe(expectedBalance)

          // Reconcile should agree.
          const reconcile = await service.reconcileBalance({
            projectId: "proj_1",
            ledgerId: ledger!.id,
          })
          expect(reconcile.err).toBeUndefined()
          expect(reconcile.val!.cached).toBe(expectedBalance)
          expect(reconcile.val!.computed).toBe(expectedBalance)
        }
      ),
      { numRuns: 100 }
    )
  })

  it("settle then reverse restores unsettled balance to original", () => {
    fc.assert(
      fc.asyncProperty(fc.array(amountArb, { minLength: 1, maxLength: 10 }), async (amounts) => {
        const repo = new InMemoryLedgerRepository()
        const service = new LedgerService({
          repo,
          logger: mockLogger,
          metrics: {} as Metrics,
        })

        const entryIds: string[] = []

        for (let i = 0; i < amounts.length; i++) {
          const result = await service.postDebit({
            projectId: "proj_1",
            customerId: "cust_1",
            currency: "USD",
            amountMinor: amounts[i]!,
            sourceType: "prop_test",
            sourceId: `debit_${i}`,
            now: 1000 + i,
          })
          expect(result.err).toBeUndefined()
          entryIds.push(result.val!.id)
        }

        const totalDebited = amounts.reduce((sum, a) => sum + a, BigInt(0))

        // Unsettled balance before settlement
        const beforeSettle = await service.getUnsettledBalance({
          projectId: "proj_1",
          customerId: "cust_1",
          currency: "USD",
        })
        expect(beforeSettle.val).toBe(totalDebited)

        // Settle all entries
        const settleResult = await service.settleEntries({
          projectId: "proj_1",
          entryIds,
          type: "invoice",
          artifactId: "inv_prop",
          now: 5000,
        })
        expect(settleResult.err).toBeUndefined()

        // After settlement, unsettled balance should be 0
        const afterSettle = await service.getUnsettledBalance({
          projectId: "proj_1",
          customerId: "cust_1",
          currency: "USD",
        })
        expect(afterSettle.val).toBe(BigInt(0))

        // Reverse the settlement
        const reverseResult = await service.reverseSettlement({
          projectId: "proj_1",
          artifactId: "inv_prop",
          type: "invoice",
          reason: "property test reversal",
          now: 6000,
        })
        expect(reverseResult.err).toBeUndefined()
        expect(reverseResult.val!.reversalEntries.length).toBe(amounts.length)

        // Ledger balance should be 0 (debits cancelled by reversal credits)
        const ledger = await repo.findLedger({
          projectId: "proj_1",
          customerId: "cust_1",
          currency: "USD",
        })
        expect(ledger!.balanceMinor).toBe(BigInt(0))
      }),
      { numRuns: 100 }
    )
  })

  it("idempotent posts — same sourceId always returns same entry without double-counting", () => {
    fc.assert(
      fc.asyncProperty(amountArb, async (amount) => {
        const repo = new InMemoryLedgerRepository()
        const service = new LedgerService({
          repo,
          logger: mockLogger,
          metrics: {} as Metrics,
        })

        const input = {
          projectId: "proj_1",
          customerId: "cust_1",
          currency: "USD" as const,
          amountMinor: amount,
          sourceType: "idem_test",
          sourceId: "same_source",
          now: 1000,
        }

        const first = await service.postDebit(input)
        expect(first.err).toBeUndefined()

        const second = await service.postDebit(input)
        expect(second.err).toBeUndefined()
        expect(second.val!.id).toBe(first.val!.id)

        // Balance counted once, not twice
        const ledger = await repo.findLedger({
          projectId: "proj_1",
          customerId: "cust_1",
          currency: "USD",
        })
        expect(ledger!.balanceMinor).toBe(amount)
      }),
      { numRuns: 200 }
    )
  })
})
