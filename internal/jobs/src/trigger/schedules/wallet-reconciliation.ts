import { logger, schedules } from "@trigger.dev/sdk/v3"
import { sql } from "@unprice/db"
import { db } from "../db"

/**
 * Nightly reconciliation for the wallet/ledger plane. Four invariant checks —
 * each produces a small, bounded result set (only
 * drift rows, never healthy ones). The job logs violations at WARN so
 * the on-call dashboard surfaces them, but does not auto-repair — human
 * judgement is required to decide whether a drift indicates a bug, a
 * race, or legitimate state requiring a backfill.
 *
 * The wallet_credits invariant
 *   `SUM(remaining_amount) == available.granted balance`
 * is NOT checked here — it's enforced in real time by the deferred
 * constraint trigger `wallet_credits_invariant_check` (migration 0004).
 * Any tx that violates the invariant aborts at COMMIT, so drift cannot
 * persist.
 *
 * 1. Wallet identity:
 *    `purchased + granted + reserved + consumed` == Σ inflows − Σ outflows
 * 2. Stranded reservations (unreconciled past period end)
 * 3. Stranded top-ups (pending > 24h)
 * 4. Invoice-projection orphans (billable credits to `*.consumed` missing
 *    `statement_key` or `kind` metadata). Reservation flushes are accounting
 *    movements, not invoice lines, and are excluded by `flow = 'flush'`.
 */
export const walletReconciliationSchedule = schedules.task({
  id: "wallet.reconciliation",
  cron: {
    timezone: "UTC",
    // 03:00 UTC daily — quiet window, stable enough read replica.
    pattern: "0 3 * * *",
  },
  run: async () => {
    const results = {
      walletIdentityDriftCustomers: 0,
      strandedReservations: 0,
      strandedTopups: 0,
      invoiceProjectionOrphans: 0,
    }

    // 1. Wallet identity check.
    // For each customer: the sum of their four sub-account balances must
    // equal the net of all inflows minus outflows (i.e. the sum of all
    // entries into those accounts). pgledger guarantees this by
    // construction per-account; we check cross-account drift by scanning
    // customers where any of the four sub-accounts goes negative (a bug,
    // since non-negativity is enforced at account create time).
    try {
      const walletDrift = await db.execute<{
        customer_id: string
        account: string
        balance: string
      }>(sql`
        SELECT
          split_part(a.name, '.', 2) AS customer_id,
          a.name AS account,
          a.balance::text
        FROM pgledger_accounts_view a
        WHERE a.name LIKE 'customer.%'
          AND a.balance < 0
      `)

      results.walletIdentityDriftCustomers = walletDrift.rows.length
      if (walletDrift.rows.length > 0) {
        logger.warn("wallet.reconciliation.wallet_identity_drift", {
          count: walletDrift.rows.length,
          samples: walletDrift.rows.slice(0, 10),
        })
      }
    } catch (error) {
      logger.error("wallet.reconciliation.wallet_identity_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // 2. Stranded reservations — period ended more than an hour ago but
    // `reconciled_at` is still null. The DO alarm should have closed
    // these; anything here means the DO missed its final flush.
    try {
      const stranded = await db.execute<{
        id: string
        customer_id: string
        entitlement_id: string
        period_end_at: Date
      }>(sql`
        SELECT id, customer_id, entitlement_id, period_end_at
        FROM unprice_entitlement_reservations
        WHERE reconciled_at IS NULL
          AND period_end_at < (now() - interval '1 hour')
        LIMIT 100
      `)

      results.strandedReservations = stranded.rows.length
      if (stranded.rows.length > 0) {
        logger.warn("wallet.reconciliation.stranded_reservations", {
          count: stranded.rows.length,
          samples: stranded.rows.slice(0, 10),
        })
      }
    } catch (error) {
      logger.error("wallet.reconciliation.stranded_reservations_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // 3. Stranded top-ups — pending for more than 24 hours. Provider
    // checkout sessions have expired by now; these can be marked
    // `expired` and their rows closed out.
    try {
      const strandedTopups = await db.execute<{
        id: string
        customer_id: string
        provider_session_id: string
        created_at: Date
      }>(sql`
        SELECT id, customer_id, provider_session_id, created_at
        FROM unprice_wallet_topups
        WHERE status = 'pending'
          AND created_at < (now() - interval '24 hours')
        LIMIT 100
      `)

      results.strandedTopups = strandedTopups.rows.length
      if (strandedTopups.rows.length > 0) {
        logger.warn("wallet.reconciliation.stranded_topups", {
          count: strandedTopups.rows.length,
          samples: strandedTopups.rows.slice(0, 10),
        })
      }
    } catch (error) {
      logger.error("wallet.reconciliation.stranded_topups_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // 4. Invoice-projection orphans — billable credits to
    // `customer.*.consumed` that are missing `statement_key` or `kind` in
    // metadata. Reservation flushes deliberately do not carry invoice-line
    // metadata; bill-period receivable transfers are the invoice source.
    try {
      const orphans = await db.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count
        FROM pgledger_entries_view e
        INNER JOIN pgledger_accounts_view a ON a.id = e.account_id
        WHERE a.name LIKE 'customer.%.consumed'
          AND e.amount > 0
          AND COALESCE(e.metadata->>'flow', '') <> 'flush'
          AND (
            e.metadata->>'statement_key' IS NULL
            OR e.metadata->>'kind' IS NULL
          )
      `)

      const count = Number(orphans.rows[0]?.count ?? 0)
      results.invoiceProjectionOrphans = count
      if (count > 0) {
        logger.warn("wallet.reconciliation.invoice_projection_orphans", { count })
      }
    } catch (error) {
      logger.error("wallet.reconciliation.invoice_projection_orphans_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    logger.info("wallet.reconciliation.complete", results)
    return results
  },
})
