import type { Database } from "@unprice/db"
import type {
  Customer,
  PlanVersion,
  Subscription,
  SubscriptionItem,
  SubscriptionPhase,
  SubscriptionPhaseExtended,
  SubscriptionStatus,
} from "@unprice/db/validators"

// ─── Input types ────────────────────────────────────────────────────────────

export interface FindSubscriptionInput {
  subscriptionId: string
  projectId?: string
}

export interface FindSubscriptionWithPhasesInput {
  subscriptionId: string
  projectId?: string
}

export interface FindSubscriptionFullInput {
  subscriptionId: string
  projectId?: string
}

/** loadSubscription in invokes.ts needs phases filtered by `now`, with deep joins */
export interface FindSubscriptionForMachineInput {
  subscriptionId: string
  projectId: string
  now: number
}

export interface InsertSubscriptionInput {
  id: string
  projectId: string
  customerId: string
  active: boolean
  status: SubscriptionStatus
  timezone: string
  metadata: Record<string, unknown> | null
  currentCycleStartAt: number
  currentCycleEndAt: number
}

export interface UpdateSubscriptionInput {
  subscriptionId: string
  projectId: string
  data: Partial<
    Pick<
      Subscription,
      | "active"
      | "status"
      | "planSlug"
      | "renewAt"
      | "currentCycleStartAt"
      | "currentCycleEndAt"
      | "metadata"
    >
  >
}

export interface InsertPhaseInput {
  id: string
  projectId: string
  planVersionId: string
  subscriptionId: string
  paymentMethodId: string | null
  paymentProvider: string
  trialEndsAt: number | null
  trialUnits: number
  startAt: number
  endAt?: number | null
  metadata: Record<string, unknown> | null
  billingAnchor: number
}

export interface UpdatePhaseInput {
  phaseId: string
  data: Partial<Pick<SubscriptionPhase, "startAt" | "endAt">>
}

export interface DeletePhaseInput {
  phaseId: string
  projectId: string
}

export interface FindPhaseInput {
  phaseId: string
  projectId: string
}

export interface InsertItemsInput {
  items: Array<{
    id: string
    subscriptionPhaseId: string
    projectId: string
    featurePlanVersionId: string
    units: number | null
    subscriptionId: string
  }>
}

export interface UpdateItemUnitsInput {
  projectId: string
  updates: Array<{ id: string; units: number | null }>
}

export interface ListSubscriptionsByProjectInput {
  projectId: string
  page: number
  pageSize: number
  from?: number | null
  to?: number | null
}

export interface ListSubscriptionsByPlanVersionInput {
  planVersionId: string
  projectId: string
}

// ─── Return types for complex queries ──────────────────────────────────────

/** Shape returned by findSubscriptionForMachine — the full context for the state machine */
export interface SubscriptionMachineData {
  subscription: Subscription
  customer: Customer
  phases: SubscriptionPhaseExtended[]
}

/** Shape returned by findSubscriptionFull — getSubscriptionById deep query */
export type SubscriptionFullData = Subscription & {
  phases: Array<
    SubscriptionPhase & {
      planVersion: { plan: Record<string, unknown>; [k: string]: unknown }
      items: Array<
        SubscriptionItem & {
          featurePlanVersion: {
            feature: Record<string, unknown>
            [k: string]: unknown
          }
        }
      >
    }
  >
}

/** Shape returned by findPhaseWithItemsAndSubscription */
export type PhaseWithItemsAndSubscription = SubscriptionPhase & {
  items: SubscriptionItem[]
  subscription: Subscription & {
    customer: Customer
  }
}

/** Shape returned by findSubscriptionWithPhases — includes phases with items+featurePlanVersions */
export type SubscriptionWithPhases = Subscription & {
  phases: Array<
    SubscriptionPhase & {
      items?: Array<
        SubscriptionItem & {
          featurePlanVersion?: {
            feature?: Record<string, unknown>
            [k: string]: unknown
          } | null
        }
      >
    }
  >
}

export interface ListSubscriptionsResult {
  subscriptions: Array<Subscription & { customer: Customer }>
  pageCount: number
}

/** Shape returned by findPhaseForBilling — phase + planVersion + subscription for the invoicing flow */
export type PhaseForBilling = SubscriptionPhase & {
  planVersion: PlanVersion
  subscription: Subscription
}

export interface FindPhaseForBillingInput {
  phaseId: string
  projectId: string
  subscriptionId: string
}

// ─── Repository interface ──────────────────────────────────────────────────

export interface SubscriptionRepository {
  forDatabase?(db: Database): SubscriptionRepository

  withTransaction<T>(
    fn: (txRepo: SubscriptionRepository, txDb?: Database) => Promise<T>
  ): Promise<T>

  // ── Subscriptions ──────────────────────────────────────────────────────

  /** Find a subscription by ID (optionally scoped to project). Returns bare subscription. */
  findSubscription(input: FindSubscriptionInput): Promise<Subscription | null>

  /** Find subscription with all phases (optionally filtered by startAt). Used by createPhase, updatePhase. */
  findSubscriptionWithPhases(
    input: FindSubscriptionWithPhasesInput & { phasesFromStartAt?: number }
  ): Promise<SubscriptionWithPhases | null>

  /** Deep load for getSubscriptionById — subscription + phases + planVersion.plan + items + featurePlanVersion.feature */
  findSubscriptionFull(input: FindSubscriptionFullInput): Promise<SubscriptionFullData | null>

  /** Deep load for the state machine — subscription + active phases + customer + deep item joins */
  findSubscriptionForMachine(
    input: FindSubscriptionForMachineInput
  ): Promise<SubscriptionMachineData | null>

  insertSubscription(input: InsertSubscriptionInput): Promise<Subscription | null>

  updateSubscription(input: UpdateSubscriptionInput): Promise<Subscription | null>

  /** Paginated list with customer join, dynamic date filters */
  listSubscriptionsByProject(
    input: ListSubscriptionsByProjectInput
  ): Promise<ListSubscriptionsResult>

  /** Simple list filtered by plan version */
  listSubscriptionsByPlanVersion(
    input: ListSubscriptionsByPlanVersionInput
  ): Promise<Subscription[]>

  // ── Phases ─────────────────────────────────────────────────────────────

  findPhase(input: FindPhaseInput): Promise<SubscriptionPhase | null>

  /** Find phase with items and subscription.customer — used by removePhase */
  findPhaseWithItemsAndSubscription(
    input: FindPhaseInput
  ): Promise<PhaseWithItemsAndSubscription | null>

  /** Find phase with planVersion + subscription — used by invoiceSubscription */
  findPhaseForBilling(input: FindPhaseForBillingInput): Promise<PhaseForBilling | null>

  insertPhase(input: InsertPhaseInput): Promise<SubscriptionPhase | null>

  updatePhase(input: UpdatePhaseInput): Promise<SubscriptionPhase | null>

  deletePhase(input: DeletePhaseInput): Promise<SubscriptionPhase | null>

  // ── Items ──────────────────────────────────────────────────────────────

  insertItems(input: InsertItemsInput): Promise<SubscriptionItem[]>

  /** Batch update item units using dynamic SQL CASE expression */
  updateItemUnits(input: UpdateItemUnitsInput): Promise<void>
}
