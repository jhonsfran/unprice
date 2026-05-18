import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { vi } from "vitest"
import type { SubscriptionContext } from "../subscriptions/types"

export function createBillingLogger(errors: unknown[] = []): Logger {
  return {
    set: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((error: unknown) => {
      errors.push(error)
    }),
    flush: vi.fn(),
  } as unknown as Logger
}

export function createBillingAnalytics(usageByFeature: Record<string, number>): Analytics {
  return {
    getUsageBillingFeatures: vi.fn(
      async ({
        features,
      }: {
        features: Array<{ featureSlug: string }>
      }) =>
        Ok(
          features.map((feature) => ({
            featureSlug: feature.featureSlug,
            usage: usageByFeature[feature.featureSlug] ?? 0,
          }))
        )
    ),
    ingestEvents: vi.fn(),
  } as unknown as Analytics
}

export async function loadBillingSubscriptionContext({
  db,
  projectId,
  customerId,
  subscriptionId,
  now,
}: {
  db: Database
  projectId: string
  customerId: string
  subscriptionId: string
  now: number
}): Promise<SubscriptionContext> {
  const subscription = await db.query.subscriptions.findFirst({
    where: (table, ops) =>
      ops.and(ops.eq(table.projectId, projectId), ops.eq(table.id, subscriptionId)),
  })
  const customer = await db.query.customers.findFirst({
    where: (table, ops) =>
      ops.and(ops.eq(table.projectId, projectId), ops.eq(table.id, customerId)),
  })

  if (!subscription || !customer) {
    throw new Error("Seeded subscription context was not restored")
  }

  return {
    now,
    subscriptionId,
    projectId,
    subscription,
    customer,
    paymentMethodId: null,
    requiredPaymentMethod: false,
    currentPhase: null,
  }
}
