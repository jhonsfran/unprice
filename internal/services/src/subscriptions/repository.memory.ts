import type {
  Customer,
  Subscription,
  SubscriptionItem,
  SubscriptionPhase,
} from "@unprice/db/validators"

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

export class InMemorySubscriptionRepository implements SubscriptionRepository {
  readonly subscriptions: Subscription[] = []
  readonly phases: SubscriptionPhase[] = []
  readonly items: SubscriptionItem[] = []
  readonly customers: Customer[] = []

  readonly planVersionsByPhaseId: Map<string, Record<string, unknown>> = new Map()
  readonly featurePlanVersionsByItemId: Map<string, Record<string, unknown>> = new Map()

  async withTransaction<T>(fn: (txRepo: SubscriptionRepository) => Promise<T>): Promise<T> {
    return fn(this)
  }

  async findSubscription(input: FindSubscriptionInput): Promise<Subscription | null> {
    return (
      this.subscriptions.find(
        (s) =>
          s.id === input.subscriptionId &&
          (input.projectId == null || s.projectId === input.projectId)
      ) ?? null
    )
  }

  async findSubscriptionWithPhases(
    input: FindSubscriptionWithPhasesInput & { phasesFromStartAt?: number }
  ): Promise<SubscriptionWithPhases | null> {
    const sub = this.subscriptions.find(
      (s) =>
        s.id === input.subscriptionId &&
        (input.projectId == null || s.projectId === input.projectId)
    )
    if (!sub) return null

    let matchingPhases = this.phases.filter((p) => p.subscriptionId === sub.id)
    if (input.phasesFromStartAt != null) {
      matchingPhases = matchingPhases.filter((p) => p.startAt >= input.phasesFromStartAt!)
    }

    const phasesWithItems = matchingPhases.map((phase) => {
      const phaseItems = this.items.filter((i) => i.subscriptionPhaseId === phase.id)
      const itemsWithFpv = phaseItems.map((item) => ({
        ...item,
        featurePlanVersion:
          (this.featurePlanVersionsByItemId.get(item.id) as
            | (Record<string, unknown> & { feature?: Record<string, unknown> })
            | undefined) ?? undefined,
      }))
      return { ...phase, items: itemsWithFpv }
    })

    return { ...sub, phases: phasesWithItems } as SubscriptionWithPhases
  }

  async findSubscriptionFull(
    input: FindSubscriptionFullInput
  ): Promise<SubscriptionFullData | null> {
    const sub = this.subscriptions.find(
      (s) =>
        s.id === input.subscriptionId &&
        (input.projectId == null || s.projectId === input.projectId)
    )
    if (!sub) return null

    const allPhases = this.phases
      .filter((p) => p.subscriptionId === sub.id)
      .sort((a, b) => a.startAt - b.startAt)
      .map((phase) => {
        const phaseItems = this.items
          .filter((i) => i.subscriptionPhaseId === phase.id)
          .map((item) => ({
            ...item,
            featurePlanVersion: (this.featurePlanVersionsByItemId.get(item.id) as Record<
              string,
              unknown
            > & {
              feature: Record<string, unknown>
            }) ?? { feature: {} },
          }))
        const planVersion = (this.planVersionsByPhaseId.get(phase.id) as Record<string, unknown> & {
          plan: Record<string, unknown>
        }) ?? { plan: {} }
        return { ...phase, planVersion, items: phaseItems }
      })

    return { ...sub, phases: allPhases } as unknown as SubscriptionFullData
  }

  async findSubscriptionForMachine(
    input: FindSubscriptionForMachineInput
  ): Promise<SubscriptionMachineData | null> {
    const sub = this.subscriptions.find(
      (s) => s.id === input.subscriptionId && s.projectId === input.projectId
    )
    if (!sub) return null

    const customer = this.customers.find((c) => c.id === sub.customerId)
    if (!customer) return null

    const activePhases = this.phases
      .filter(
        (p) =>
          p.subscriptionId === sub.id &&
          p.startAt <= input.now &&
          (p.endAt == null || p.endAt >= input.now)
      )
      .slice(0, 1)
      .map((phase) => {
        const phaseItems = this.items
          .filter((i) => i.subscriptionPhaseId === phase.id)
          .map((item) => ({
            ...item,
            featurePlanVersion: (this.featurePlanVersionsByItemId.get(item.id) as Record<
              string,
              unknown
            > & {
              feature: { slug: string; title: string }
            }) ?? { feature: { slug: "", title: "" } },
          }))
        const planVersion = (this.planVersionsByPhaseId.get(phase.id) as Record<string, unknown> & {
          billingConfig: Record<string, unknown>
          plan: { slug: string }
        }) ?? { billingConfig: {}, plan: { slug: "" } }
        return { ...phase, planVersion, items: phaseItems }
      })

    return {
      subscription: sub,
      customer,
      phases: activePhases,
    } as unknown as SubscriptionMachineData
  }

  async insertSubscription(input: InsertSubscriptionInput): Promise<Subscription | null> {
    const now = Date.now()
    const sub = {
      ...input,
      planSlug: null,
      autoRenew: true,
      renewAt: null,
      currentCycleStartAt: input.currentCycleStartAt,
      currentCycleEndAt: input.currentCycleEndAt,
      createdAtM: now,
      updatedAtM: now,
    } as unknown as Subscription
    this.subscriptions.push(sub)
    return sub
  }

  async updateSubscription(input: UpdateSubscriptionInput): Promise<Subscription | null> {
    const idx = this.subscriptions.findIndex(
      (s) => s.id === input.subscriptionId && s.projectId === input.projectId
    )
    if (idx === -1) return null

    const current = this.subscriptions[idx]!
    const updated = { ...current, ...input.data, updatedAtM: Date.now() } as Subscription
    this.subscriptions[idx] = updated
    return updated
  }

  async listSubscriptionsByProject(
    input: ListSubscriptionsByProjectInput
  ): Promise<ListSubscriptionsResult> {
    let filtered = this.subscriptions.filter((s) => s.projectId === input.projectId)

    if (input.from != null) {
      filtered = filtered.filter((s) => s.createdAtM >= input.from!)
    }
    if (input.to != null) {
      filtered = filtered.filter((s) => s.createdAtM <= input.to!)
    }

    filtered.sort((a, b) => b.createdAtM - a.createdAtM)

    const total = filtered.length
    const start = (input.page - 1) * input.pageSize
    const paged = filtered.slice(start, start + input.pageSize)

    const withCustomer = paged.map((sub) => {
      const customer = this.customers.find((c) => c.id === sub.customerId)
      return { ...sub, customer: customer ?? ({} as Customer) }
    })

    return {
      subscriptions: withCustomer,
      pageCount: Math.ceil(total / input.pageSize),
    }
  }

  async listSubscriptionsByPlanVersion(
    input: ListSubscriptionsByPlanVersionInput
  ): Promise<Subscription[]> {
    const subIds = new Set(
      this.phases
        .filter((p) => p.planVersionId === input.planVersionId)
        .map((p) => p.subscriptionId)
    )
    return this.subscriptions.filter((s) => s.projectId === input.projectId && subIds.has(s.id))
  }

  async findPhase(input: FindPhaseInput): Promise<SubscriptionPhase | null> {
    return (
      this.phases.find((p) => p.id === input.phaseId && p.projectId === input.projectId) ?? null
    )
  }

  async findPhaseWithItemsAndSubscription(
    input: FindPhaseInput
  ): Promise<PhaseWithItemsAndSubscription | null> {
    const phase = this.phases.find((p) => p.id === input.phaseId && p.projectId === input.projectId)
    if (!phase) return null

    const phaseItems = this.items.filter((i) => i.subscriptionPhaseId === phase.id)
    const sub = this.subscriptions.find((s) => s.id === phase.subscriptionId)
    if (!sub) return null

    const customer = this.customers.find((c) => c.id === sub.customerId)
    if (!customer) return null

    return {
      ...phase,
      items: phaseItems,
      subscription: { ...sub, customer },
    } as PhaseWithItemsAndSubscription
  }

  async findPhaseForBilling(input: FindPhaseForBillingInput): Promise<PhaseForBilling | null> {
    const phase = this.phases.find(
      (p) =>
        p.id === input.phaseId &&
        p.projectId === input.projectId &&
        p.subscriptionId === input.subscriptionId
    )
    if (!phase) return null

    const planVersion = this.planVersionsByPhaseId.get(phase.id) as
      | PhaseForBilling["planVersion"]
      | undefined
    if (!planVersion) return null

    const sub = this.subscriptions.find((s) => s.id === phase.subscriptionId)
    if (!sub) return null

    return {
      ...phase,
      planVersion,
      subscription: sub,
    } as PhaseForBilling
  }

  async insertPhase(input: InsertPhaseInput): Promise<SubscriptionPhase | null> {
    const now = Date.now()
    const phase = {
      ...input,
      endAt: input.endAt ?? null,
      createdAtM: now,
      updatedAtM: now,
    } as unknown as SubscriptionPhase
    this.phases.push(phase)
    return phase
  }

  async updatePhase(input: UpdatePhaseInput): Promise<SubscriptionPhase | null> {
    const idx = this.phases.findIndex((p) => p.id === input.phaseId)
    if (idx === -1) return null

    const current = this.phases[idx]!
    const updated = { ...current, ...input.data, updatedAtM: Date.now() } as SubscriptionPhase
    this.phases[idx] = updated
    return updated
  }

  async deletePhase(input: DeletePhaseInput): Promise<SubscriptionPhase | null> {
    const idx = this.phases.findIndex(
      (p) => p.id === input.phaseId && p.projectId === input.projectId
    )
    if (idx === -1) return null

    const [removed] = this.phases.splice(idx, 1)
    // cascade: remove items for this phase
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i]!.subscriptionPhaseId === input.phaseId) {
        this.items.splice(i, 1)
      }
    }
    return removed ?? null
  }

  async insertItems(input: InsertItemsInput): Promise<SubscriptionItem[]> {
    const now = Date.now()
    const inserted: SubscriptionItem[] = input.items.map((item) => {
      const si = {
        ...item,
        createdAtM: now,
        updatedAtM: now,
      } as unknown as SubscriptionItem
      this.items.push(si)
      return si
    })
    return inserted
  }

  async updateItemUnits(input: UpdateItemUnitsInput): Promise<void> {
    for (const update of input.updates) {
      const idx = this.items.findIndex((i) => i.id === update.id && i.projectId === input.projectId)
      if (idx !== -1) {
        this.items[idx] = {
          ...this.items[idx]!,
          units: update.units,
          updatedAtM: Date.now(),
        } as SubscriptionItem
      }
    }
  }
}
