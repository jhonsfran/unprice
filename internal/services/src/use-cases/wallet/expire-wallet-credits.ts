import { and, eq, isNull, lte, sql } from "@unprice/db"
import type { Database } from "@unprice/db"
import { customers, walletCredits } from "@unprice/db/schema"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"

export interface ExpireWalletCreditsInput {
  now: Date
  limit?: number
}

export interface ExpireWalletCreditsOutput {
  expiredCount: number
  skippedCount: number
}

export async function expireWalletCredits(
  deps: {
    db: Database
    logger: Logger
    services: Pick<ServiceContext, "wallet">
  },
  input: ExpireWalletCreditsInput
): Promise<ExpireWalletCreditsOutput> {
  const expiredGrants = await deps.db.query.walletCredits.findMany({
    where: and(
      isNull(walletCredits.expiredAt),
      isNull(walletCredits.voidedAt),
      lte(walletCredits.expiresAt, input.now)
    ),
    limit: input.limit ?? 500,
  })

  if (expiredGrants.length === 0) {
    return { expiredCount: 0, skippedCount: 0 }
  }

  deps.logger.info(`Found ${expiredGrants.length} grants to expire`)

  let expiredCount = 0
  let skippedCount = 0

  for (const grant of expiredGrants) {
    try {
      await deps.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`customer:${grant.customerId}`}))`
        )

        const current = await tx.query.walletCredits.findFirst({
          where: and(eq(walletCredits.id, grant.id), eq(walletCredits.projectId, grant.projectId)),
        })

        if (!current) {
          skippedCount += 1
          return
        }

        if (current.expiredAt || current.voidedAt) {
          skippedCount += 1
          return
        }

        if (current.remainingAmount === 0) {
          await tx
            .update(walletCredits)
            .set({ expiredAt: input.now })
            .where(
              and(eq(walletCredits.id, current.id), eq(walletCredits.projectId, current.projectId))
            )
          skippedCount += 1
          return
        }

        const customer = await tx.query.customers.findFirst({
          columns: { defaultCurrency: true },
          where: and(
            eq(customers.id, current.customerId),
            eq(customers.projectId, current.projectId)
          ),
        })

        if (!customer) {
          deps.logger.error("wallet.expire_grant.customer_missing", {
            grantId: current.id,
            customerId: current.customerId,
            projectId: current.projectId,
          })
          skippedCount += 1
          return
        }

        const result = await deps.services.wallet.expireGrant(tx, {
          customerId: current.customerId,
          projectId: current.projectId,
          currency: customer.defaultCurrency,
          grantId: current.id,
          amount: current.remainingAmount,
          source: current.source,
          idempotencyKey: `expire:${current.id}`,
        })

        if (result.err) {
          throw result.err
        }

        await tx
          .update(walletCredits)
          .set({
            remainingAmount: 0,
            expiredAt: input.now,
          })
          .where(
            and(eq(walletCredits.id, current.id), eq(walletCredits.projectId, current.projectId))
          )

        expiredCount += 1
      })
    } catch (error) {
      deps.logger.error("wallet.expire_grant_failed", {
        error: error instanceof Error ? error.message : String(error),
        grantId: grant.id,
        customerId: grant.customerId,
        projectId: grant.projectId,
      })
      skippedCount += 1
    }
  }

  return { expiredCount, skippedCount }
}
