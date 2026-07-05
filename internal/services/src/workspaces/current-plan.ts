import type { Database } from "@unprice/db"

export function fallbackWorkspacePlanSlug({
  isInternal,
  isMain,
}: {
  isInternal: boolean
  isMain: boolean
}): string | null {
  return isInternal || isMain ? "pro" : null
}

export async function listCurrentPlanSlugsByCustomerId({
  db,
  customerIds,
}: {
  db: Database
  customerIds: readonly string[]
}): Promise<Map<string, string>> {
  const uniqueCustomerIds = [...new Set(customerIds.filter((customerId) => customerId.length > 0))]

  if (uniqueCustomerIds.length === 0) {
    return new Map()
  }

  const subscriptions = await db.query.subscriptions.findMany({
    columns: {
      customerId: true,
      planSlug: true,
    },
    where: (subscription, { and, eq, inArray }) =>
      and(eq(subscription.active, true), inArray(subscription.customerId, uniqueCustomerIds)),
    orderBy: (subscription, { desc }) => [
      desc(subscription.currentCycleEndAt),
      desc(subscription.updatedAtM),
    ],
  })

  const planSlugByCustomerId = new Map<string, string>()

  for (const subscription of subscriptions) {
    if (!planSlugByCustomerId.has(subscription.customerId)) {
      planSlugByCustomerId.set(subscription.customerId, subscription.planSlug)
    }
  }

  return planSlugByCustomerId
}
