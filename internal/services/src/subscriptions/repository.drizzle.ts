import { type Database, type SQL, and, count, eq, getTableColumns, inArray, sql } from "@unprice/db"
import { customers, subscriptionItems, subscriptionPhases, subscriptions } from "@unprice/db/schema"
import { withDateFilters, withPagination } from "@unprice/db/utils"
import type { Subscription, SubscriptionItem, SubscriptionPhase } from "@unprice/db/validators"

import type {
  DeletePhaseInput,
  FindPhaseForBillingInput,
  FindPhaseInput,
  FindSubscriptionForMachineInput,
  FindSubscriptionFullInput,
  FindSubscriptionInput,
  FindSubscriptionWithPhasesInput,
  InsertItemsInput,
  InsertPhaseInput,
  InsertSubscriptionInput,
  ListSubscriptionsByPlanVersionInput,
  ListSubscriptionsByProjectInput,
  ListSubscriptionsResult,
  PhaseForBilling,
  PhaseWithItemsAndSubscription,
  SubscriptionFullData,
  SubscriptionMachineData,
  SubscriptionRepository,
  SubscriptionWithPhases,
  UpdateItemUnitsInput,
  UpdatePhaseInput,
  UpdateSubscriptionInput,
} from "./repository"

type DbExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0]

export class DrizzleSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly db: DbExecutor) {}

  async withTransaction<T>(fn: (txRepo: SubscriptionRepository) => Promise<T>): Promise<T> {
    return (this.db as Database).transaction(async (tx) => {
      return fn(new DrizzleSubscriptionRepository(tx))
    })
  }

  // ── Subscriptions ────────────────────────────────────────────────────────

  async findSubscription(input: FindSubscriptionInput): Promise<Subscription | null> {
    const result = await this.db.query.subscriptions.findFirst({
      where: (table, ops) => {
        const conditions = [ops.eq(table.id, input.subscriptionId)]
        if (input.projectId) conditions.push(ops.eq(table.projectId, input.projectId))
        return ops.and(...conditions)
      },
    })
    return (result as Subscription) ?? null
  }

  async findSubscriptionWithPhases(
    input: FindSubscriptionWithPhasesInput & { phasesFromStartAt?: number }
  ): Promise<SubscriptionWithPhases | null> {
    const phasesFromStartAt = input.phasesFromStartAt
    const result = await this.db.query.subscriptions.findFirst({
      where: (sub, ops) => {
        const conditions = [ops.eq(sub.id, input.subscriptionId)]
        if (input.projectId) conditions.push(ops.eq(sub.projectId, input.projectId))
        return ops.and(...conditions)
      },
      with: {
        phases: {
          ...(phasesFromStartAt != null
            ? { where: (phase, ops) => ops.gte(phase.startAt, phasesFromStartAt) }
            : {}),
          with: {
            items: {
              with: {
                featurePlanVersion: {
                  with: {
                    feature: true,
                  },
                },
              },
            },
          },
        },
      },
    })

    return (result as unknown as SubscriptionWithPhases) ?? null
  }

  async findSubscriptionFull(
    input: FindSubscriptionFullInput
  ): Promise<SubscriptionFullData | null> {
    const result = await this.db.query.subscriptions.findFirst({
      where: (sub, ops) => {
        const conditions = [ops.eq(sub.id, input.subscriptionId)]
        if (input.projectId) conditions.push(ops.eq(sub.projectId, input.projectId))
        return ops.and(...conditions)
      },
      with: {
        phases: {
          orderBy: (phases, { asc }) => asc(phases.startAt),
          with: {
            planVersion: {
              with: {
                plan: true,
              },
            },
            items: {
              with: {
                featurePlanVersion: {
                  with: {
                    feature: true,
                  },
                },
              },
            },
          },
        },
      },
    })

    return (result as unknown as SubscriptionFullData) ?? null
  }

  async findSubscriptionForMachine(
    input: FindSubscriptionForMachineInput
  ): Promise<SubscriptionMachineData | null> {
    const result = await this.db.query.subscriptions.findFirst({
      where: (table, ops) =>
        ops.and(ops.eq(table.id, input.subscriptionId), ops.eq(table.projectId, input.projectId)),
      with: {
        customer: true,
        phases: {
          where: (phase, { lte, and: andOp, gte, isNull, or: orOp }) =>
            andOp(
              lte(phase.startAt, input.now),
              orOp(isNull(phase.endAt), gte(phase.endAt, input.now))
            ),
          limit: 1,
          with: {
            planVersion: {
              with: {
                plan: true,
              },
            },
            items: {
              with: {
                featurePlanVersion: {
                  with: {
                    feature: true,
                  },
                },
              },
            },
          },
        },
      },
    })

    if (!result) return null

    const { phases, customer, ...subscription } = result

    if (!customer) return null

    return {
      subscription: subscription as unknown as Subscription,
      customer,
      phases: phases ?? [],
    } as unknown as SubscriptionMachineData
  }

  async insertSubscription(input: InsertSubscriptionInput): Promise<Subscription | null> {
    const rows = await this.db
      .insert(subscriptions)
      .values({
        id: input.id,
        projectId: input.projectId,
        customerId: input.customerId,
        active: input.active,
        status: input.status,
        timezone: input.timezone,
        metadata: input.metadata,
        currentCycleStartAt: input.currentCycleStartAt,
        currentCycleEndAt: input.currentCycleEndAt,
      })
      .returning()

    return (rows[0] as Subscription) ?? null
  }

  async updateSubscription(input: UpdateSubscriptionInput): Promise<Subscription | null> {
    const rows = await this.db
      .update(subscriptions)
      .set({
        ...input.data,
      })
      .where(
        and(
          eq(subscriptions.id, input.subscriptionId),
          eq(subscriptions.projectId, input.projectId)
        )
      )
      .returning()

    return (rows[0] as Subscription) ?? null
  }

  async listSubscriptionsByProject(
    input: ListSubscriptionsByProjectInput
  ): Promise<ListSubscriptionsResult> {
    const columns = getTableColumns(subscriptions)
    const customerColumns = getTableColumns(customers)

    const expressions = [eq(columns.projectId, input.projectId)]

    const { data, total } = await (this.db as Database).transaction(async (tx) => {
      const query = tx
        .select({
          subscriptions: subscriptions,
          customer: customerColumns,
        })
        .from(subscriptions)
        .innerJoin(
          customers,
          and(
            eq(subscriptions.customerId, customers.id),
            eq(customers.projectId, subscriptions.projectId)
          )
        )
        .$dynamic()

      const whereQuery = withDateFilters<Subscription>(
        expressions,
        columns.createdAtM,
        input.from ?? null,
        input.to ?? null
      )

      const data = await withPagination(
        query,
        whereQuery,
        [
          {
            column: columns.createdAtM,
            order: "desc",
          },
        ],
        input.page,
        input.pageSize
      )

      const total = await tx
        .select({
          count: count(),
        })
        .from(subscriptions)
        .where(whereQuery)
        .execute()
        .then((res) => res[0]?.count ?? 0)

      return { data, total }
    })

    const subscriptionsData = data.map((row) => ({
      ...row.subscriptions,
      customer: row.customer,
    }))

    return {
      subscriptions: subscriptionsData,
      pageCount: Math.ceil(total / input.pageSize),
    } as unknown as ListSubscriptionsResult
  }

  async listSubscriptionsByPlanVersion(
    input: ListSubscriptionsByPlanVersionInput
  ): Promise<Subscription[]> {
    const result = await this.db.query.subscriptions.findMany({
      with: {
        phases: {
          where: (phase, { eq: eqOp }) => eqOp(phase.planVersionId, input.planVersionId),
        },
      },
      where: (sub, ops) => ops.eq(sub.projectId, input.projectId),
    })

    return result.filter((s) => s.phases && s.phases.length > 0) as unknown as Subscription[]
  }

  // ── Phases ─────────────────────────────────────────────────────────────────

  async findPhase(input: FindPhaseInput): Promise<SubscriptionPhase | null> {
    const result = await this.db.query.subscriptionPhases.findFirst({
      where: (phase, ops) =>
        ops.and(ops.eq(phase.id, input.phaseId), ops.eq(phase.projectId, input.projectId)),
    })
    return (result as SubscriptionPhase) ?? null
  }

  async findPhaseWithItemsAndSubscription(
    input: FindPhaseInput
  ): Promise<PhaseWithItemsAndSubscription | null> {
    const result = await this.db.query.subscriptionPhases.findFirst({
      where: (phase, ops) =>
        ops.and(ops.eq(phase.id, input.phaseId), ops.eq(phase.projectId, input.projectId)),
      with: {
        items: true,
        subscription: {
          with: {
            customer: true,
          },
        },
      },
    })

    return (result as unknown as PhaseWithItemsAndSubscription) ?? null
  }

  async findPhaseForBilling(input: FindPhaseForBillingInput): Promise<PhaseForBilling | null> {
    const result = await this.db.query.subscriptionPhases.findFirst({
      where: (phase, ops) =>
        ops.and(
          ops.eq(phase.id, input.phaseId),
          ops.eq(phase.projectId, input.projectId),
          ops.eq(phase.subscriptionId, input.subscriptionId)
        ),
      with: {
        planVersion: true,
        subscription: true,
      },
    })

    return (result as unknown as PhaseForBilling) ?? null
  }

  async insertPhase(input: InsertPhaseInput): Promise<SubscriptionPhase | null> {
    const rows = await this.db
      .insert(subscriptionPhases)
      .values({
        id: input.id,
        projectId: input.projectId,
        planVersionId: input.planVersionId,
        subscriptionId: input.subscriptionId,
        paymentMethodId: input.paymentMethodId,
        paymentProvider: input.paymentProvider as "stripe" | "square" | "sandbox",
        trialEndsAt: input.trialEndsAt,
        trialUnits: input.trialUnits,
        startAt: input.startAt,
        endAt: input.endAt,
        metadata: input.metadata,
        billingAnchor: input.billingAnchor,
      })
      .returning()

    return (rows[0] as SubscriptionPhase) ?? null
  }

  async updatePhase(input: UpdatePhaseInput): Promise<SubscriptionPhase | null> {
    const rows = await this.db
      .update(subscriptionPhases)
      .set({
        ...input.data,
      })
      .where(eq(subscriptionPhases.id, input.phaseId))
      .returning()

    return (rows[0] as SubscriptionPhase) ?? null
  }

  async deletePhase(input: DeletePhaseInput): Promise<SubscriptionPhase | null> {
    const rows = await this.db
      .delete(subscriptionPhases)
      .where(
        and(
          eq(subscriptionPhases.id, input.phaseId),
          eq(subscriptionPhases.projectId, input.projectId)
        )
      )
      .returning()

    return (rows[0] as SubscriptionPhase) ?? null
  }

  // ── Items ──────────────────────────────────────────────────────────────────

  async insertItems(input: InsertItemsInput): Promise<SubscriptionItem[]> {
    const rows = await this.db.insert(subscriptionItems).values(input.items).returning()

    return rows as SubscriptionItem[]
  }

  async updateItemUnits(input: UpdateItemUnitsInput): Promise<void> {
    if (input.updates.length === 0) return

    const sqlChunks: SQL[] = []
    const ids: string[] = []

    sqlChunks.push(sql`(case`)

    for (const update of input.updates) {
      sqlChunks.push(
        update.units === null
          ? sql`when ${subscriptionItems.id} = ${update.id} then NULL`
          : sql`when ${subscriptionItems.id} = ${update.id} then cast(${update.units} as int)`
      )
      ids.push(update.id)
    }

    sqlChunks.push(sql`end)`)

    const finalSql: SQL = sql.join(sqlChunks, sql.raw(" "))

    await this.db
      .update(subscriptionItems)
      .set({ units: finalSql })
      .where(
        and(inArray(subscriptionItems.id, ids), eq(subscriptionItems.projectId, input.projectId))
      )
  }
}
