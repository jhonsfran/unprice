import { z } from "zod"
import { createDeterministicIdGenerator } from "./factories"
import {
  ReferenceBillingModel,
  type ReferenceCurrency,
  type ReferenceCustomer,
  type ReferenceInvoice,
  type ReferenceLedgerMovement,
  type ReferencePlan,
  type ReferenceSubscription,
  type ReferenceUsageEvent,
  referenceCurrencySchema,
  referenceInvoiceSchema,
  referenceLedgerMovementSchema,
  referenceMeteringStateSchema,
  referenceWalletStateSchema,
} from "./reference-model"

export const expectedInvoiceLineSchema = z.object({
  kind: z.enum(["flat", "usage", "credit", "adjustment", "proration_credit", "proration_charge"]),
  featureSlug: z.string().min(1).optional(),
  quantity: z.number().optional(),
  amountCents: z.number().int(),
})

export const expectedInvoiceSchema = z.object({
  totalCents: z.number().int(),
  currency: z.enum(["USD", "EUR"]).optional(),
  lines: z.array(expectedInvoiceLineSchema),
})

export const expectedMeteringSchema = z.object({
  acceptedEventIds: z.array(z.string()).optional(),
  acceptedUsageByFeature: z.record(z.string(), z.number()).optional(),
  rejectedEventIds: z.array(z.string()).optional(),
})

export const expectedWalletSchema = referenceWalletStateSchema.partial().extend({
  customerId: z.string().min(1).default("cus_test"),
  currency: referenceCurrencySchema.optional(),
})

export const expectedLedgerSchema = z.object({
  movements: z.array(referenceLedgerMovementSchema.partial()).optional(),
  movementCount: z.number().int().min(0).optional(),
})

export type ExpectedInvoice = z.input<typeof expectedInvoiceSchema>
export type ExpectedMetering = z.input<typeof expectedMeteringSchema>
export type ExpectedWallet = z.input<typeof expectedWalletSchema>
export type ExpectedLedger = z.input<typeof expectedLedgerSchema>

type ScenarioCommand = {
  name: string
  run: (runtime: ScenarioRuntime) => void
}

type ScenarioAssertion = (runtime: ScenarioRuntime) => void

export type ScenarioRunResult = {
  model: ReferenceBillingModel
  invoices: ReferenceInvoice[]
  ledgerMovements: ReferenceLedgerMovement[]
}

export type BuiltBillingScenario = {
  name: string
  fixtures: string[]
  commandNames: string[]
}

export class ScenarioRuntime {
  private clockMs: number
  private readonly nextId = createDeterministicIdGenerator()

  constructor(
    readonly model: ReferenceBillingModel,
    initialClockMs = Date.parse("2026-01-01T00:00:00.000Z")
  ) {
    this.clockMs = initialClockMs
  }

  now() {
    return this.clockMs
  }

  id(prefix: string) {
    return this.nextId(prefix)
  }

  at(value: string | number | Date) {
    this.clockMs = toEpochMs(value)
    return this.clockMs
  }

  advanceClockBy(milliseconds: number) {
    if (!Number.isInteger(milliseconds) || milliseconds < 0) {
      throw new Error("Clock advancement must be a non-negative integer number of milliseconds")
    }
    this.clockMs += milliseconds
    return this.clockMs
  }

  givenCustomer(customer: ReferenceCustomer) {
    this.model.addCustomer(customer)
  }

  givenPlan(plan: ReferencePlan) {
    this.model.addPlan(plan)
  }

  givenSubscription(input: ReferenceSubscription & { periodStart: number; periodEnd: number }) {
    const subscription = this.model.addSubscription(input)
    this.model.createBillingPeriod({
      subscriptionId: subscription.id,
      customerId: subscription.customerId,
      planId: subscription.planId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    })
  }

  meterUsage(event: ReferenceUsageEvent) {
    return this.model.meterUsage(event)
  }

  billPeriod(input: { subscriptionId: string; periodStart: number; periodEnd: number }) {
    return this.model.billPeriod(input)
  }

  changePlan(input: {
    subscriptionId: string
    planId: string
    effectiveAt?: string | number | Date
    phaseId?: string
  }) {
    return this.model.changeSubscriptionPlan({
      subscriptionId: input.subscriptionId,
      planId: input.planId,
      phaseId: input.phaseId,
      effectiveAt: input.effectiveAt === undefined ? this.now() : toEpochMs(input.effectiveAt),
    })
  }

  cancelSubscription(input: { subscriptionId: string; effectiveAt?: string | number | Date }) {
    this.model.cancelSubscription({
      subscriptionId: input.subscriptionId,
      effectiveAt: input.effectiveAt === undefined ? this.now() : toEpochMs(input.effectiveAt),
    })
  }

  addProrationLines(input: {
    subscriptionId: string
    periodStart: string | number | Date
    periodEnd: string | number | Date
    changeAt: string | number | Date
    oldAmountCents: number
    newAmountCents: number
    featureSlug?: string
  }) {
    return this.model.addProrationLines({
      subscriptionId: input.subscriptionId,
      periodStart: toEpochMs(input.periodStart),
      periodEnd: toEpochMs(input.periodEnd),
      changeAt: toEpochMs(input.changeAt),
      oldAmountCents: input.oldAmountCents,
      newAmountCents: input.newAmountCents,
      featureSlug: input.featureSlug,
    })
  }

  applyCreditToPeriod(input: {
    id?: string
    subscriptionId: string
    customerId: string
    currency: ReferenceCurrency
    periodStart: string | number | Date
    periodEnd: string | number | Date
    amountCents: number
  }) {
    return this.model.applyCreditToPeriod({
      id: input.id ?? this.id("credit"),
      subscriptionId: input.subscriptionId,
      customerId: input.customerId,
      currency: input.currency,
      periodStart: toEpochMs(input.periodStart),
      periodEnd: toEpochMs(input.periodEnd),
      amountCents: input.amountCents,
    })
  }

  createCredit(input: {
    id?: string
    customerId: string
    currency: ReferenceCurrency
    amountCents: number
    source?: string
  }) {
    return this.model.createCredit({
      id: input.id ?? this.id("wcr"),
      customerId: input.customerId,
      currency: input.currency,
      amountCents: input.amountCents,
      source: input.source,
    })
  }

  reserveWallet(input: {
    id?: string
    customerId: string
    currency: ReferenceCurrency
    amountCents: number
  }) {
    return this.model.reserveWallet({
      id: input.id ?? this.id("res"),
      customerId: input.customerId,
      currency: input.currency,
      amountCents: input.amountCents,
    })
  }

  consumeWalletReservation(input: { reservationId: string; amountCents: number }) {
    return this.model.consumeWalletReservation(input)
  }

  releaseWalletReservation(input: { reservationId: string; amountCents?: number }) {
    return this.model.releaseWalletReservation(input)
  }
}

export class BillingScenarioBuilder {
  private fixtureNames: string[] = []
  private commands: ScenarioCommand[] = []
  private afterEachAssertions: ScenarioAssertion[] = []
  private invoiceExpectation?: ExpectedInvoice
  private meteringExpectation?: ExpectedMetering
  private walletExpectations: ExpectedWallet[] = []
  private ledgerExpectation?: ExpectedLedger

  constructor(readonly name: string) {}

  withFixtures(fixtures: string[]) {
    this.fixtureNames = fixtures
    return this
  }

  get fixtures() {
    return [...this.fixtureNames]
  }

  build(): BuiltBillingScenario {
    return {
      name: this.name,
      fixtures: this.fixtures,
      commandNames: this.commands.map((command) => command.name),
    }
  }

  at(value: string | number | Date) {
    this.commands.push({
      name: "set clock",
      run: (runtime) => {
        runtime.at(value)
      },
    })
    return this
  }

  advanceClockBy(milliseconds: number) {
    this.commands.push({
      name: "advance clock",
      run: (runtime) => {
        runtime.advanceClockBy(milliseconds)
      },
    })
    return this
  }

  givenCustomer(customer: ReferenceCustomer | string) {
    const payload =
      typeof customer === "string"
        ? ({
            id: customer,
            currency: "EUR",
          } satisfies ReferenceCustomer)
        : customer

    this.commands.push({
      name: "given customer",
      run: (runtime) => runtime.givenCustomer(payload),
    })
    return this
  }

  givenPlan(plan: ReferencePlan) {
    this.commands.push({
      name: "given plan",
      run: (runtime) => runtime.givenPlan(plan),
    })
    return this
  }

  givenSubscription(input: ReferenceSubscription & { periodStart: number; periodEnd: number }) {
    this.commands.push({
      name: "given subscription",
      run: (runtime) => runtime.givenSubscription(input),
    })
    return this
  }

  meterUsage(event: ReferenceUsageEvent) {
    this.commands.push({
      name: "meter usage",
      run: (runtime) => {
        runtime.meterUsage(event)
      },
    })
    return this
  }

  billPeriod(
    periodStart: string | number,
    periodEnd: string | number,
    subscriptionId = "sub_test"
  ) {
    const start = toEpochMs(periodStart)
    const end = toEpochMs(periodEnd)
    this.commands.push({
      name: "bill period",
      run: (runtime) => {
        runtime.billPeriod({ subscriptionId, periodStart: start, periodEnd: end })
      },
    })
    return this
  }

  step(name: string, run: (runtime: ScenarioRuntime) => void) {
    this.commands.push({ name, run })
    return this
  }

  assertAfterEachStep(...assertions: ScenarioAssertion[]) {
    this.afterEachAssertions.push(...assertions)
    return this
  }

  expectInvoice(expectation: ExpectedInvoice) {
    this.invoiceExpectation = expectedInvoiceSchema.parse(expectation)
    return this
  }

  expectMetering(expectation: ExpectedMetering) {
    this.meteringExpectation = expectedMeteringSchema.parse(expectation)
    return this
  }

  expectWallet(expectation: ExpectedWallet) {
    this.walletExpectations.push(expectedWalletSchema.parse(expectation))
    return this
  }

  expectLedger(expectation: ExpectedLedger) {
    this.ledgerExpectation = expectedLedgerSchema.parse(expectation)
    return this
  }

  runReferenceModel() {
    const model = new ReferenceBillingModel()
    const runtime = new ScenarioRuntime(model)

    for (const command of this.commands) {
      command.run(runtime)
      for (const assertion of this.afterEachAssertions) {
        assertion(runtime)
      }
    }

    const invoices = model.getInvoices()
    const ledgerMovements = model.getLedgerMovements()
    if (this.invoiceExpectation) {
      assertInvoiceExpectation(invoices.at(-1), this.invoiceExpectation)
    }
    if (this.meteringExpectation) {
      assertMeteringExpectation(model, this.meteringExpectation)
    }
    for (const walletExpectation of this.walletExpectations) {
      assertWalletExpectation(model, walletExpectation)
    }
    if (this.ledgerExpectation) {
      assertLedgerExpectation(ledgerMovements, this.ledgerExpectation)
    }

    return {
      model,
      invoices,
      ledgerMovements,
    } satisfies ScenarioRunResult
  }
}

export function scenario(name: string) {
  return new BillingScenarioBuilder(name)
}

export function assertMeteringInvariants(runtime: ScenarioRuntime) {
  const eventIds = runtime.model.getMeteringState().acceptedEventIds
  if (new Set(eventIds).size !== eventIds.length) {
    throw new Error("Accepted usage events contain duplicates")
  }
}

export function assertLedgerInvariants(runtime: ScenarioRuntime) {
  runtime.model.assertLedgerConservation()
}

function assertInvoiceExpectation(
  invoice: ReferenceInvoice | undefined,
  expectation: ExpectedInvoice
) {
  if (!invoice) {
    throw new Error("Expected an invoice, but no invoice was produced")
  }
  const parsedInvoice = referenceInvoiceSchema.parse(invoice)

  if (expectation.currency && parsedInvoice.currency !== expectation.currency) {
    throw new Error(
      `Expected invoice currency ${expectation.currency}, got ${parsedInvoice.currency}`
    )
  }
  if (parsedInvoice.totalCents !== expectation.totalCents) {
    throw new Error(
      `Expected invoice total ${expectation.totalCents}, got ${parsedInvoice.totalCents}`
    )
  }
  if (parsedInvoice.lines.length !== expectation.lines.length) {
    throw new Error(
      `Expected ${expectation.lines.length} invoice lines, got ${parsedInvoice.lines.length}`
    )
  }

  expectation.lines.forEach((expectedLine, index) => {
    const actualLine = parsedInvoice.lines[index]
    if (!actualLine) {
      throw new Error(`Missing invoice line at index ${index}`)
    }
    if (actualLine.kind !== expectedLine.kind) {
      throw new Error(`Expected line ${index} kind ${expectedLine.kind}, got ${actualLine.kind}`)
    }
    if (expectedLine.featureSlug && actualLine.featureSlug !== expectedLine.featureSlug) {
      throw new Error(
        `Expected line ${index} feature ${expectedLine.featureSlug}, got ${actualLine.featureSlug}`
      )
    }
    if (expectedLine.quantity !== undefined && actualLine.quantity !== expectedLine.quantity) {
      throw new Error(
        `Expected line ${index} quantity ${expectedLine.quantity}, got ${actualLine.quantity}`
      )
    }
    if (actualLine.amountCents !== expectedLine.amountCents) {
      throw new Error(
        `Expected line ${index} amount ${expectedLine.amountCents}, got ${actualLine.amountCents}`
      )
    }
  })
}

function assertMeteringExpectation(model: ReferenceBillingModel, expectation: ExpectedMetering) {
  const parsedExpectation = expectedMeteringSchema.parse(expectation)
  const meteringState = referenceMeteringStateSchema.parse(model.getMeteringState())

  if (parsedExpectation.acceptedEventIds) {
    expectArrayValues(
      "accepted event IDs",
      meteringState.acceptedEventIds,
      parsedExpectation.acceptedEventIds
    )
  }
  if (parsedExpectation.rejectedEventIds) {
    expectArrayValues(
      "rejected event IDs",
      meteringState.rejectedEvents.map((event) => event.eventId),
      parsedExpectation.rejectedEventIds
    )
  }
  if (parsedExpectation.acceptedUsageByFeature) {
    for (const [featureSlug, expectedQuantity] of Object.entries(
      parsedExpectation.acceptedUsageByFeature
    )) {
      const actualQuantity = meteringState.acceptedUsageByFeature[featureSlug] ?? 0
      if (actualQuantity !== expectedQuantity) {
        throw new Error(
          `Expected accepted usage for ${featureSlug} to be ${expectedQuantity}, got ${actualQuantity}`
        )
      }
    }
  }
}

function assertWalletExpectation(model: ReferenceBillingModel, expectation: ExpectedWallet) {
  const parsedExpectation = expectedWalletSchema.parse(expectation)
  const walletState = model.getWalletState(parsedExpectation.customerId, parsedExpectation.currency)

  for (const key of ["availableCents", "reservedCents", "consumedCents"] as const) {
    const expectedValue = parsedExpectation[key]
    if (expectedValue !== undefined && walletState[key] !== expectedValue) {
      throw new Error(`Expected wallet ${key} to be ${expectedValue}, got ${walletState[key]}`)
    }
  }
}

function assertLedgerExpectation(
  ledgerMovements: ReferenceLedgerMovement[],
  expectation: ExpectedLedger
) {
  const parsedExpectation = expectedLedgerSchema.parse(expectation)

  if (
    parsedExpectation.movementCount !== undefined &&
    ledgerMovements.length !== parsedExpectation.movementCount
  ) {
    throw new Error(
      `Expected ${parsedExpectation.movementCount} ledger movements, got ${ledgerMovements.length}`
    )
  }

  for (const movementExpectation of parsedExpectation.movements ?? []) {
    const matched = ledgerMovements.some((movement) =>
      matchesPartialMovement(movement, movementExpectation)
    )
    if (!matched) {
      throw new Error(
        `Expected ledger movement was not found: ${JSON.stringify(movementExpectation)}`
      )
    }
  }
}

function matchesPartialMovement(
  movement: ReferenceLedgerMovement,
  expectation: Partial<ReferenceLedgerMovement>
) {
  return Object.entries(expectation).every(([key, value]) => {
    if (value === undefined) return true
    return movement[key as keyof ReferenceLedgerMovement] === value
  })
}

function expectArrayValues(label: string, actual: string[], expected: string[]) {
  const missing = expected.filter((value) => !actual.includes(value))
  if (missing.length > 0) {
    throw new Error(`Expected ${label} to include ${missing.join(", ")}`)
  }
}

function toEpochMs(value: string | number | Date) {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  return Date.parse(value)
}
