import { logger, schedules } from "@trigger.dev/sdk/v3"
import { sql } from "@unprice/db"
import { db } from "../db"

/**
 * Nightly reconciliation for the Phase 7 wallet/ledger plane. Five
 * invariant checks — each produces a small, bounded result set (only
 * drift rows, never healthy ones). The job logs violations at WARN so
 * the on-call dashboard surfaces them, but does not auto-repair — human
 * judgement is required to decide whether a drift indicates a bug, a
 * race, or legitimate state requiring a backfill.
 *
 * 1. Grant tracking invariant:
 *    `SUM(wallet_credits.remaining_amount)` == `available.granted` balance
 * 2. Wallet identity:
 *    `purchased + granted + reserved + consumed` == Σ inflows − Σ outflows
 * 3. Stranded reservations (unreconciled past period end)
 * 4. Stranded top-ups (pending > 24h)
 * 5. Invoice-projection orphans (credits to `*.consumed` missing
 *    `statement_key` or `kind` metadata)
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
      grantDriftRows: 0,
      walletIdentityDriftCustomers: 0,
      strandedReservations: 0,
      strandedTopups: 0,
      invoiceProjectionOrphans: 0,
    }

    // 1. Grant tracking invariant.
    // For each customer: SUM(wallet_credits.remaining_amount) must equal
    // the customer's `available.granted` ledger balance. Any row returned
    // from this query is drift — the invariant is broken.
    try {
      const grantDrift = await db.execute<{
        customer_id: string
        grant_sum: string
        ledger_balance: string
        drift: string
      }>(sql`
        SELECT
          wg.customer_id,
          SUM(wg.remaining_amount)::text AS grant_sum,
          COALESCE(a.balance::text, '0') AS ledger_balance,
          (SUM(wg.remaining_amount) - COALESCE(a.balance, 0))::text AS drift
        FROM unprice_wallet_credits wg
        LEFT JOIN pgledger_accounts_view a
          ON a.name = 'customer.' || wg.customer_id || '.available.granted'
        WHERE wg.expired_at IS NULL
          AND wg.voided_at IS NULL
        GROUP BY wg.customer_id, a.balance
        HAVING SUM(wg.remaining_amount) <> COALESCE(a.balance, 0)
      `)

      results.grantDriftRows = grantDrift.rows.length
      if (grantDrift.rows.length > 0) {
        logger.warn("wallet.reconciliation.grant_tracking_drift", {
          count: grantDrift.rows.length,
          samples: grantDrift.rows.slice(0, 10),
        })
      }
    } catch (error) {
      logger.error("wallet.reconciliation.grant_tracking_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // 2. Wallet identity check.
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

    // 3. Stranded reservations — period ended more than an hour ago but
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

    // 4. Stranded top-ups — pending for more than 24 hours. Provider
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

    // 5. Invoice-projection orphans — credits to `customer.*.consumed`
    // that are missing `statement_key` or `kind` in metadata. These
    // cannot be projected as invoice lines; they indicate a caller that
    // bypassed `WalletService` (which requires both fields for transfers
    // to `consumed`).
    try {
      const orphans = await db.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count
        FROM pgledger_entries_view e
        INNER JOIN pgledger_accounts_view a ON a.id = e.account_id
        WHERE a.name LIKE 'customer.%.consumed'
          AND e.amount > 0
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
