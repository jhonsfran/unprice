import { z } from "zod"

export const referenceCurrencySchema = z.enum(["USD", "EUR"])
export const referenceWhenToBillSchema = z.enum(["pay_in_arrear", "pay_in_advance"])
export const referenceFeatureSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    kind: z.literal("flat"),
    amountCents: z.number().int().min(0),
  }),
  z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    kind: z.literal("usage"),
    unitPriceCents: z.number().int().min(0),
    includedUnits: z.number().min(0).default(0),
  }),
])

export const referencePlanSchema = z.object({
  id: z.string().min(1),
  currency: referenceCurrencySchema,
  whenToBill: referenceWhenToBillSchema,
  features: z.array(referenceFeatureSchema),
})

export const referenceCustomerSchema = z.object({
  id: z.string().min(1),
  currency: referenceCurrencySchema,
})

export const referenceSubscriptionSchema = z.object({
  id: z.string().min(1),
  customerId: z.string().min(1),
  planId: z.string().min(1),
  startsAt: z.number().int(),
})

export const referenceSubscriptionPhaseSchema = z.object({
  id: z.string().min(1),
  subscriptionId: z.string().min(1),
  planId: z.string().min(1),
  startsAt: z.number().int(),
  endsAt: z.number().int().nullable().default(null),
})

export const referenceUsageEventSchema = z.object({
  id: z.string().min(1),
  customerId: z.string().min(1),
  subscriptionId: z.string().min(1),
  featureSlug: z.string().min(1),
  quantity: z.number().min(0),
  occurredAt: z.number().int(),
})

export const referenceBillingPeriodSchema = z.object({
  id: z.string().min(1),
  subscriptionId: z.string().min(1),
  customerId: z.string().min(1),
  planId: z.string().min(1),
  periodStart: z.number().int(),
  periodEnd: z.number().int(),
  statementKey: z.string().min(1),
})

export const referenceInvoiceLineSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["flat", "usage", "credit", "adjustment", "proration_credit", "proration_charge"]),
  featureSlug: z.string().min(1).optional(),
  quantity: z.number().optional(),
  amountCents: z.number().int(),
  periodStart: z.number().int(),
  periodEnd: z.number().int(),
})

export const referenceInvoiceSchema = z.object({
  id: z.string().min(1),
  subscriptionId: z.string().min(1),
  customerId: z.string().min(1),
  currency: referenceCurrencySchema,
  status: z.enum(["draft", "finalized"]),
  statementKey: z.string().min(1),
  periodStart: z.number().int(),
  periodEnd: z.number().int(),
  totalCents: z.number().int(),
  lines: z.array(referenceInvoiceLineSchema),
})

export const referenceLedgerMovementSchema = z.object({
  id: z.string().min(1),
  statementKey: z.string().min(1),
  customerId: z.string().min(1),
  currency: referenceCurrencySchema,
  debitAccount: z.string().min(1),
  creditAccount: z.string().min(1),
  amountCents: z.number().int().positive(),
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
})

export const referenceWalletStateSchema = z.object({
  availableCents: z.number().int().min(0),
  reservedCents: z.number().int().min(0),
  consumedCents: z.number().int().min(0),
})

export const referenceRejectedUsageEventSchema = z.object({
  eventId: z.string().min(1),
  reason: z.enum(["OUTSIDE_BILLING_PERIOD", "UNKNOWN_SUBSCRIPTION"]),
})

export const referenceMeteringStateSchema = z.object({
  acceptedEventIds: z.array(z.string().min(1)),
  acceptedUsageByFeature: z.record(z.string().min(1), z.number().min(0)),
  rejectedEvents: z.array(referenceRejectedUsageEventSchema),
})

export const referenceProrationInputSchema = z.object({
  oldAmountCents: z.number().int().min(0),
  newAmountCents: z.number().int().min(0),
  periodStart: z.number().int(),
  periodEnd: z.number().int(),
  changeAt: z.number().int(),
  granularity: z.enum(["day", "week", "month", "year", "minute"]).default("month"),
})

export type ReferenceCurrency = z.infer<typeof referenceCurrencySchema>
export type ReferencePlan = z.infer<typeof referencePlanSchema>
export type ReferenceCustomer = z.infer<typeof referenceCustomerSchema>
export type ReferenceSubscription = z.infer<typeof referenceSubscriptionSchema>
export type ReferenceSubscriptionPhase = z.infer<typeof referenceSubscriptionPhaseSchema>
export type ReferenceUsageEvent = z.infer<typeof referenceUsageEventSchema>
export type ReferenceBillingPeriod = z.infer<typeof referenceBillingPeriodSchema>
export type ReferenceInvoice = z.infer<typeof referenceInvoiceSchema>
export type ReferenceInvoiceLine = z.infer<typeof referenceInvoiceLineSchema>
export type ReferenceLedgerMovement = z.infer<typeof referenceLedgerMovementSchema>
export type ReferenceWalletState = z.infer<typeof referenceWalletStateSchema>
export type ReferenceMeteringState = z.infer<typeof referenceMeteringStateSchema>
export type ReferenceProrationInput = z.infer<typeof referenceProrationInputSchema>

export type MeterUsageResult =
  | { status: "accepted"; event: ReferenceUsageEvent }
  | { status: "duplicate"; event: ReferenceUsageEvent }
  | { status: "rejected"; reason: "OUTSIDE_BILLING_PERIOD" | "UNKNOWN_SUBSCRIPTION" }

type WalletGrant = {
  id: string
  customerId: string
  currency: ReferenceCurrency
  amountCents: number
  remainingCents: number
  source: string
}

type WalletReservation = {
  id: string
  customerId: string
  currency: ReferenceCurrency
  allocationCents: number
  consumedCents: number
  allocations: Array<{ grantId: string; amountCents: number }>
}

const dayLikeGranularities = new Set<ReferenceProrationInput["granularity"]>([
  "day",
  "week",
  "month",
  "year",
])

function startOfUtcDay(ms: number) {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function normalizeProrationTime(ms: number, granularity: ReferenceProrationInput["granularity"]) {
  return dayLikeGranularities.has(granularity) ? startOfUtcDay(ms) : ms
}

function prorateCents(amountCents: number, remaining: number, total: number) {
  if (total <= 0) {
    throw new Error("Invalid proration period")
  }
  return Math.round((amountCents * remaining) / total)
}

export function calculateReferenceProration(input: ReferenceProrationInput) {
  const parsed = referenceProrationInputSchema.parse(input)
  const periodStart = normalizeProrationTime(parsed.periodStart, parsed.granularity)
  const periodEnd = normalizeProrationTime(parsed.periodEnd, parsed.granularity)
  const changeAt = normalizeProrationTime(parsed.changeAt, parsed.granularity)
  const boundedChangeAt = Math.min(Math.max(changeAt, periodStart), periodEnd)
  const total = periodEnd - periodStart
  const remaining = periodEnd - boundedChangeAt
  const oldCreditCents = prorateCents(parsed.oldAmountCents, remaining, total)
  const newChargeCents = prorateCents(parsed.newAmountCents, remaining, total)

  return {
    oldCreditCents,
    newChargeCents,
    netProrationCents: newChargeCents - oldCreditCents,
    remaining,
    total,
  }
}

export class ReferenceBillingModel {
  private readonly customers = new Map<string, ReferenceCustomer>()
  private readonly plans = new Map<string, ReferencePlan>()
  private readonly subscriptions = new Map<string, ReferenceSubscription>()
  private readonly phases = new Map<string, ReferenceSubscriptionPhase>()
  private readonly billingPeriods = new Map<string, ReferenceBillingPeriod>()
  private readonly canceledSubscriptions = new Map<string, number>()
  private readonly acceptedUsageEvents = new Map<string, ReferenceUsageEvent>()
  private readonly rejectedUsageEvents: ReferenceMeteringState["rejectedEvents"] = []
  private readonly invoicesByStatement = new Map<string, ReferenceInvoice>()
  private readonly pendingInvoiceLines = new Map<string, ReferenceInvoiceLine[]>()
  private readonly walletGrants = new Map<string, WalletGrant>()
  private readonly walletReservations = new Map<string, WalletReservation>()
  private readonly ledgerMovements: ReferenceLedgerMovement[] = []

  addCustomer(customer: ReferenceCustomer) {
    const parsed = referenceCustomerSchema.parse(customer)
    this.customers.set(parsed.id, parsed)
    return parsed
  }

  addPlan(plan: ReferencePlan) {
    const parsed = referencePlanSchema.parse(plan)
    this.plans.set(parsed.id, parsed)
    return parsed
  }

  addSubscription(subscription: ReferenceSubscription) {
    const parsed = referenceSubscriptionSchema.parse(subscription)

    if (!this.customers.has(parsed.customerId)) {
      throw new Error(`Unknown customer: ${parsed.customerId}`)
    }
    if (!this.plans.has(parsed.planId)) {
      throw new Error(`Unknown plan: ${parsed.planId}`)
    }

    this.subscriptions.set(parsed.id, parsed)
    this.addSubscriptionPhase({
      id: `phase_${parsed.id}_initial`,
      subscriptionId: parsed.id,
      planId: parsed.planId,
      startsAt: parsed.startsAt,
      endsAt: null,
    })
    return parsed
  }

  addSubscriptionPhase(phase: ReferenceSubscriptionPhase) {
    const parsed = referenceSubscriptionPhaseSchema.parse(phase)

    if (!this.subscriptions.has(parsed.subscriptionId)) {
      throw new Error(`Unknown subscription: ${parsed.subscriptionId}`)
    }
    if (!this.plans.has(parsed.planId)) {
      throw new Error(`Unknown plan: ${parsed.planId}`)
    }

    this.phases.set(parsed.id, parsed)
    return parsed
  }

  changeSubscriptionPlan(input: {
    subscriptionId: string
    planId: string
    effectiveAt: number
    phaseId?: string
  }) {
    const subscription = this.getSubscription(input.subscriptionId)

    if (!this.plans.has(input.planId)) {
      throw new Error(`Unknown plan: ${input.planId}`)
    }

    for (const phase of this.phases.values()) {
      if (
        phase.subscriptionId === subscription.id &&
        phase.startsAt < input.effectiveAt &&
        (phase.endsAt === null || phase.endsAt > input.effectiveAt)
      ) {
        phase.endsAt = input.effectiveAt
      }
    }

    return this.addSubscriptionPhase({
      id: input.phaseId ?? `phase_${subscription.id}_${input.effectiveAt}`,
      subscriptionId: subscription.id,
      planId: input.planId,
      startsAt: input.effectiveAt,
      endsAt: null,
    })
  }

  cancelSubscription(input: { subscriptionId: string; effectiveAt: number }) {
    const subscription = this.getSubscription(input.subscriptionId)
    this.canceledSubscriptions.set(subscription.id, input.effectiveAt)

    for (const phase of this.phases.values()) {
      if (
        phase.subscriptionId === subscription.id &&
        phase.startsAt < input.effectiveAt &&
        (phase.endsAt === null || phase.endsAt > input.effectiveAt)
      ) {
        phase.endsAt = input.effectiveAt
      }
    }
  }

  createBillingPeriod(input: Omit<ReferenceBillingPeriod, "id" | "statementKey">) {
    const statementKey = this.statementKey(input.subscriptionId, input.periodStart, input.periodEnd)
    const existing = this.billingPeriods.get(statementKey)
    if (existing) return existing

    const period = referenceBillingPeriodSchema.parse({
      ...input,
      id: `bp_${statementKey}`,
      statementKey,
    })
    this.billingPeriods.set(statementKey, period)
    return period
  }

  meterUsage(event: ReferenceUsageEvent): MeterUsageResult {
    const parsed = referenceUsageEventSchema.parse(event)
    const subscription = this.subscriptions.get(parsed.subscriptionId)

    if (!subscription) {
      this.rejectedUsageEvents.push({ eventId: parsed.id, reason: "UNKNOWN_SUBSCRIPTION" })
      return { status: "rejected", reason: "UNKNOWN_SUBSCRIPTION" }
    }

    const existing = this.acceptedUsageEvents.get(parsed.id)
    if (existing) {
      return { status: "duplicate", event: existing }
    }

    const activePeriod = this.findPeriodForEvent(parsed.subscriptionId, parsed.occurredAt)
    if (!activePeriod) {
      this.rejectedUsageEvents.push({ eventId: parsed.id, reason: "OUTSIDE_BILLING_PERIOD" })
      return { status: "rejected", reason: "OUTSIDE_BILLING_PERIOD" }
    }

    this.acceptedUsageEvents.set(parsed.id, parsed)
    return { status: "accepted", event: parsed }
  }

  billPeriod(input: {
    subscriptionId: string
    periodStart: number
    periodEnd: number
    finalize?: boolean
  }) {
    const subscription = this.getSubscription(input.subscriptionId)
    const customer = this.getCustomer(subscription.customerId)
    const plan = this.getPlanForBillingPeriod(
      subscription.id,
      subscription.planId,
      input.periodStart
    )
    const period = this.createBillingPeriod({
      subscriptionId: subscription.id,
      customerId: subscription.customerId,
      planId: subscription.planId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    })
    const existing = this.invoicesByStatement.get(period.statementKey)

    if (existing) {
      return existing
    }

    const isCanceledBeforePeriod =
      (this.canceledSubscriptions.get(subscription.id) ?? Number.POSITIVE_INFINITY) <=
      period.periodStart
    const featureLines = isCanceledBeforePeriod
      ? []
      : plan.features.flatMap((feature) => {
          if (feature.kind === "flat") {
            if (feature.amountCents === 0) return []
            return [
              referenceInvoiceLineSchema.parse({
                id: `line_${period.statementKey}_${feature.slug}`,
                kind: "flat",
                featureSlug: feature.slug,
                quantity: 1,
                amountCents: feature.amountCents,
                periodStart: period.periodStart,
                periodEnd: period.periodEnd,
              }),
            ]
          }

          const quantity = this.usageQuantityForPeriod({
            subscriptionId: subscription.id,
            featureSlug: feature.slug,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
          })
          const billableQuantity = Math.max(0, quantity - feature.includedUnits)
          const amountCents = Math.round(billableQuantity * feature.unitPriceCents)

          if (amountCents === 0) return []

          return [
            referenceInvoiceLineSchema.parse({
              id: `line_${period.statementKey}_${feature.slug}`,
              kind: "usage",
              featureSlug: feature.slug,
              quantity: billableQuantity,
              amountCents,
              periodStart: period.periodStart,
              periodEnd: period.periodEnd,
            }),
          ]
        })
    const lines = [...featureLines, ...(this.pendingInvoiceLines.get(period.statementKey) ?? [])]

    const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0)
    const invoice = referenceInvoiceSchema.parse({
      id: `inv_${period.statementKey}`,
      subscriptionId: subscription.id,
      customerId: customer.id,
      currency: plan.currency,
      status: input.finalize ? "finalized" : "draft",
      statementKey: period.statementKey,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      totalCents,
      lines,
    })

    this.invoicesByStatement.set(period.statementKey, invoice)
    this.postInvoiceLedger(invoice)
    return invoice
  }

  addInvoiceLine(
    input: Omit<ReferenceInvoiceLine, "id" | "periodStart" | "periodEnd"> & {
      id?: string
      subscriptionId: string
      periodStart: number
      periodEnd: number
    }
  ) {
    const statementKey = this.statementKey(input.subscriptionId, input.periodStart, input.periodEnd)
    if (this.invoicesByStatement.has(statementKey)) {
      throw new Error("Cannot add an invoice line after the period has been billed")
    }

    const line = referenceInvoiceLineSchema.parse({
      id:
        input.id ?? `line_${statementKey}_${input.kind}_${this.pendingLineCount(statementKey) + 1}`,
      kind: input.kind,
      featureSlug: input.featureSlug,
      quantity: input.quantity,
      amountCents: input.amountCents,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    })
    const existing = this.pendingInvoiceLines.get(statementKey) ?? []
    existing.push(line)
    this.pendingInvoiceLines.set(statementKey, existing)
    return line
  }

  addProrationLines(input: {
    subscriptionId: string
    periodStart: number
    periodEnd: number
    changeAt: number
    oldAmountCents: number
    newAmountCents: number
    granularity?: ReferenceProrationInput["granularity"]
    featureSlug?: string
  }) {
    const proration = calculateReferenceProration({
      oldAmountCents: input.oldAmountCents,
      newAmountCents: input.newAmountCents,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      changeAt: input.changeAt,
      granularity: input.granularity ?? "month",
    })
    const lines: ReferenceInvoiceLine[] = []

    if (proration.oldCreditCents > 0) {
      lines.push(
        this.addInvoiceLine({
          subscriptionId: input.subscriptionId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          kind: "proration_credit",
          featureSlug: input.featureSlug,
          amountCents: -proration.oldCreditCents,
        })
      )
    }
    if (proration.newChargeCents > 0) {
      lines.push(
        this.addInvoiceLine({
          subscriptionId: input.subscriptionId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          kind: "proration_charge",
          featureSlug: input.featureSlug,
          amountCents: proration.newChargeCents,
        })
      )
    }

    return { proration, lines }
  }

  applyCreditToPeriod(input: {
    id: string
    subscriptionId: string
    customerId: string
    currency: ReferenceCurrency
    periodStart: number
    periodEnd: number
    amountCents: number
  }) {
    const reservation = this.reserveWallet({
      id: `res_${input.id}`,
      customerId: input.customerId,
      currency: input.currency,
      amountCents: input.amountCents,
    })
    if (reservation.status !== "reserved") {
      throw new Error("Cannot apply credit without available wallet balance")
    }
    this.consumeWalletReservation({
      reservationId: reservation.reservation.id,
      amountCents: input.amountCents,
    })

    return this.addInvoiceLine({
      id: `line_${input.id}`,
      subscriptionId: input.subscriptionId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      kind: "credit",
      amountCents: -input.amountCents,
    })
  }

  createCredit(input: {
    id: string
    customerId: string
    currency: ReferenceCurrency
    amountCents: number
    source?: string
  }) {
    return this.createWalletGrant({
      id: input.id,
      customerId: input.customerId,
      currency: input.currency,
      amountCents: input.amountCents,
      source: input.source ?? "credit",
    })
  }

  createWalletGrant(input: {
    id: string
    customerId: string
    currency: ReferenceCurrency
    amountCents: number
    source: string
  }) {
    if (input.amountCents <= 0) {
      throw new Error("Wallet grant amount must be positive")
    }
    const grant: WalletGrant = {
      ...input,
      remainingCents: input.amountCents,
    }
    this.walletGrants.set(grant.id, grant)
    this.postLedgerMovement({
      statementKey: `wallet:${grant.id}`,
      customerId: grant.customerId,
      currency: grant.currency,
      debitAccount: `platform.${grant.source}`,
      creditAccount: `customer.${grant.customerId}.wallet.available`,
      amountCents: grant.amountCents,
      sourceType: "wallet_grant",
      sourceId: grant.id,
    })
    return grant
  }

  reserveWallet(input: {
    id: string
    customerId: string
    currency: ReferenceCurrency
    amountCents: number
  }) {
    if (input.amountCents <= 0) {
      throw new Error("Wallet reservation amount must be positive")
    }

    const available = this.walletAvailableCents(input.customerId, input.currency)
    if (available < input.amountCents) {
      return { status: "denied" as const, reason: "WALLET_EMPTY" as const }
    }

    let remaining = input.amountCents
    const allocations: WalletReservation["allocations"] = []
    for (const grant of this.walletGrants.values()) {
      if (grant.customerId !== input.customerId || grant.currency !== input.currency) continue
      const drained = Math.min(grant.remainingCents, remaining)
      if (drained > 0) {
        allocations.push({ grantId: grant.id, amountCents: drained })
      }
      grant.remainingCents -= drained
      remaining -= drained
      if (remaining === 0) break
    }

    const reservation: WalletReservation = {
      id: input.id,
      customerId: input.customerId,
      currency: input.currency,
      allocationCents: input.amountCents,
      consumedCents: 0,
      allocations,
    }
    this.walletReservations.set(input.id, reservation)
    this.postLedgerMovement({
      statementKey: `wallet:${input.id}`,
      customerId: input.customerId,
      currency: input.currency,
      debitAccount: `customer.${input.customerId}.wallet.available`,
      creditAccount: `customer.${input.customerId}.wallet.reserved`,
      amountCents: input.amountCents,
      sourceType: "wallet_reservation",
      sourceId: input.id,
    })
    return { status: "reserved" as const, reservation }
  }

  consumeWalletReservation(input: { reservationId: string; amountCents: number }) {
    if (input.amountCents <= 0) {
      throw new Error("Wallet consumption amount must be positive")
    }

    const reservation = this.walletReservations.get(input.reservationId)
    if (!reservation) {
      throw new Error(`Unknown wallet reservation: ${input.reservationId}`)
    }

    const remaining = reservation.allocationCents - reservation.consumedCents
    if (remaining < input.amountCents) {
      throw new Error("Reservation is underfunded")
    }

    reservation.consumedCents += input.amountCents
    this.postLedgerMovement({
      statementKey: `wallet:${reservation.id}`,
      customerId: reservation.customerId,
      currency: reservation.currency,
      debitAccount: `customer.${reservation.customerId}.wallet.reserved`,
      creditAccount: `customer.${reservation.customerId}.wallet.consumed`,
      amountCents: input.amountCents,
      sourceType: "wallet_consumption",
      sourceId: reservation.id,
    })
    return reservation
  }

  releaseWalletReservation(input: { reservationId: string; amountCents?: number }) {
    const reservation = this.walletReservations.get(input.reservationId)
    if (!reservation) {
      throw new Error(`Unknown wallet reservation: ${input.reservationId}`)
    }

    const unconsumedCents = reservation.allocationCents - reservation.consumedCents
    const releaseCents = input.amountCents ?? unconsumedCents

    if (releaseCents <= 0) {
      throw new Error("Wallet release amount must be positive")
    }
    if (releaseCents > unconsumedCents) {
      throw new Error("Cannot release more than the unconsumed reservation")
    }

    let remaining = releaseCents
    for (const allocation of [...reservation.allocations].reverse()) {
      const restored = Math.min(allocation.amountCents, remaining)
      if (restored === 0) continue

      const grant = this.walletGrants.get(allocation.grantId)
      if (!grant) {
        throw new Error(`Unknown wallet grant allocation: ${allocation.grantId}`)
      }

      grant.remainingCents += restored
      allocation.amountCents -= restored
      remaining -= restored
      if (remaining === 0) break
    }

    reservation.allocations = reservation.allocations.filter(
      (allocation) => allocation.amountCents > 0
    )
    reservation.allocationCents -= releaseCents
    this.postLedgerMovement({
      statementKey: `wallet:${reservation.id}`,
      customerId: reservation.customerId,
      currency: reservation.currency,
      debitAccount: `customer.${reservation.customerId}.wallet.reserved`,
      creditAccount: `customer.${reservation.customerId}.wallet.available`,
      amountCents: releaseCents,
      sourceType: "wallet_release",
      sourceId: reservation.id,
    })
    return reservation
  }

  getInvoices() {
    return [...this.invoicesByStatement.values()]
  }

  getLedgerMovements() {
    return [...this.ledgerMovements]
  }

  getAcceptedUsageEvents() {
    return [...this.acceptedUsageEvents.values()]
  }

  getMeteringState(): ReferenceMeteringState {
    const acceptedUsageByFeature = this.getAcceptedUsageEvents().reduce<Record<string, number>>(
      (totals, event) => {
        totals[event.featureSlug] = (totals[event.featureSlug] ?? 0) + event.quantity
        return totals
      },
      {}
    )

    return referenceMeteringStateSchema.parse({
      acceptedEventIds: this.getAcceptedUsageEvents().map((event) => event.id),
      acceptedUsageByFeature,
      rejectedEvents: this.rejectedUsageEvents,
    })
  }

  getSubscriptionPhases(subscriptionId: string) {
    return [...this.phases.values()].filter((phase) => phase.subscriptionId === subscriptionId)
  }

  getWalletState(customerId: string, currency?: ReferenceCurrency): ReferenceWalletState {
    const availableCents = this.walletAvailableCents(customerId, currency)
    const reservations = [...this.walletReservations.values()].filter(
      (reservation) =>
        reservation.customerId === customerId &&
        (currency === undefined || reservation.currency === currency)
    )
    const reservedCents = reservations.reduce(
      (sum, reservation) => sum + reservation.allocationCents - reservation.consumedCents,
      0
    )
    const consumedCents = reservations.reduce(
      (sum, reservation) => sum + reservation.consumedCents,
      0
    )

    return referenceWalletStateSchema.parse({
      availableCents,
      reservedCents,
      consumedCents,
    })
  }

  assertLedgerConservation() {
    for (const movement of this.ledgerMovements) {
      referenceLedgerMovementSchema.parse(movement)
    }
  }

  private findPeriodForEvent(subscriptionId: string, occurredAt: number) {
    return [...this.billingPeriods.values()].find(
      (period) =>
        period.subscriptionId === subscriptionId &&
        period.periodStart <= occurredAt &&
        occurredAt < period.periodEnd
    )
  }

  private usageQuantityForPeriod(input: {
    subscriptionId: string
    featureSlug: string
    periodStart: number
    periodEnd: number
  }) {
    return [...this.acceptedUsageEvents.values()]
      .filter(
        (event) =>
          event.subscriptionId === input.subscriptionId &&
          event.featureSlug === input.featureSlug &&
          input.periodStart <= event.occurredAt &&
          event.occurredAt < input.periodEnd
      )
      .reduce((sum, event) => sum + event.quantity, 0)
  }

  private getCustomer(customerId: string) {
    const customer = this.customers.get(customerId)
    if (!customer) throw new Error(`Unknown customer: ${customerId}`)
    return customer
  }

  private getPlan(planId: string) {
    const plan = this.plans.get(planId)
    if (!plan) throw new Error(`Unknown plan: ${planId}`)
    return plan
  }

  private getPlanForBillingPeriod(
    subscriptionId: string,
    fallbackPlanId: string,
    periodStart: number
  ) {
    const phase = [...this.phases.values()]
      .filter(
        (candidate) =>
          candidate.subscriptionId === subscriptionId &&
          candidate.startsAt <= periodStart &&
          (candidate.endsAt === null || periodStart < candidate.endsAt)
      )
      .sort((left, right) => right.startsAt - left.startsAt)
      .at(0)

    return this.getPlan(phase?.planId ?? fallbackPlanId)
  }

  private getSubscription(subscriptionId: string) {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) throw new Error(`Unknown subscription: ${subscriptionId}`)
    return subscription
  }

  private walletAvailableCents(customerId: string, currency?: ReferenceCurrency) {
    return [...this.walletGrants.values()]
      .filter(
        (grant) =>
          grant.customerId === customerId && (currency === undefined || grant.currency === currency)
      )
      .reduce((sum, grant) => sum + grant.remainingCents, 0)
  }

  private postInvoiceLedger(invoice: ReferenceInvoice) {
    for (const line of invoice.lines) {
      if (line.amountCents === 0) continue
      const amountCents = Math.abs(line.amountCents)
      const isCredit = line.amountCents < 0
      this.postLedgerMovement({
        statementKey: invoice.statementKey,
        customerId: invoice.customerId,
        currency: invoice.currency,
        debitAccount: isCredit
          ? `revenue.${line.kind}`
          : `customer.${invoice.customerId}.receivable`,
        creditAccount: isCredit
          ? `customer.${invoice.customerId}.receivable`
          : `revenue.${line.kind}`,
        amountCents,
        sourceType: "invoice_line",
        sourceId: line.id,
      })
    }
  }

  private postLedgerMovement(input: Omit<ReferenceLedgerMovement, "id">) {
    const movement = referenceLedgerMovementSchema.parse({
      id: `rlm_${this.ledgerMovements.length + 1}`,
      ...input,
    })
    this.ledgerMovements.push(movement)
    return movement
  }

  private statementKey(subscriptionId: string, periodStart: number, periodEnd: number) {
    return `${subscriptionId}:${periodStart}:${periodEnd}`
  }

  private pendingLineCount(statementKey: string) {
    return this.pendingInvoiceLines.get(statementKey)?.length ?? 0
  }
}
