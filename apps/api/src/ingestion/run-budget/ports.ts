import type { entitlementMeterFactSchemaV1 } from "@unprice/analytics"
import type { Result } from "@unprice/error"
import type {
  CaptureReservationUsageInput,
  CaptureReservationUsageOutput,
  CreateReservationInput,
  CreateReservationOutput,
  ReleaseReservationInput,
  ReleaseReservationOutput,
  UnPriceWalletError,
} from "@unprice/services/wallet"
import type { z } from "zod"
import type { ApplyInput, ApplyResult } from "../entitlements/contracts"
import type { CaptureFailureStatus, RunCaptureStatus } from "./capture-policy"
import type { EndRunInput, RunBudgetDecision, RunBudgetSummary } from "./contracts"

export type RunState = {
  runId: string
  projectId: string
  customerId: string
  workloadType: string | null
  workloadId: string | null
  traceId: string | null
  parentRunId: string | null
  reservationId: string | null
  status: RunBudgetSummary["status"]
  currency: string
  budgetAmount: number
  reservedAmount: number
  consumedAmount: number
  flushedAmount: number
  lastCaptureSeq: number
  startedAt: number
  endedAt: number | null
  expiresAt: number | null
  lastEventAt: number | null
  metadataJson: string
  reconciliationNeeded: boolean
}

export type RunSpendBucket = {
  bucketKey: string
  runId: string
  entitlementId: string
  featureId: string | null
  statementKey: string
  billingPeriodId: string
  featurePlanVersionItemId: string
  featureSlug: string
  quantity: number
  periodStartAt: number
  periodEndAt: number
  currency: string
  consumedAmount: number
  flushedAmount: number
  pendingAmount: number
}

export type RunCaptureIntent = {
  intentKey: string
  runId: string
  bucketKey: string
  amount: number
  captureQuantity: number | null
  rangeStartQuantity: number | null
  targetQuantity: number | null
  flushSeq: number
  rangeStartAmount: number
  targetAmount: number
  status: RunCaptureStatus
  attemptCount: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export type RunIdempotencyEntry = {
  idempotencyKey: string
  runId: string
  decisionJson: string
  pricedAmount: number
  bucketDeltasJson: string
  createdAt: number
}

export type OpenRunCaptureIntent = RunCaptureIntent & {
  captureQuantity: number
  rangeStartQuantity: number
  targetQuantity: number
}

export type RunSpendBucketDelta = {
  amount: number
  billingPeriodId: string
  bucketKey: string
  currency: string
  entitlementId: string
  featureId: string | null
  featurePlanVersionItemId: string
  featureSlug: string
  periodEndAt: number
  periodStartAt: number
  quantity: number
  statementKey: string
}

export type RunBudgetStore = {
  loadRun(runId: string): Promise<RunState | undefined>
  createRun(run: RunState): Promise<void>
  loadIdempotency(idempotencyKey: string): Promise<RunIdempotencyEntry | undefined>
  persistIdempotency(
    idempotencyKey: string,
    runId: string,
    decision: RunBudgetDecision,
    pricedAmount: number,
    bucketDeltas: RunSpendBucketDelta[],
    createdAt: number
  ): Promise<void>
  commitSpendAndIdempotency(input: {
    run: RunState
    updatedRun: RunState
    idempotencyKey: string
    decision: RunBudgetDecision
    pricedAmount: number
    bucketDeltas: RunSpendBucketDelta[]
    createdAt: number
  }): Promise<void>
  listUnflushedBuckets(): Promise<RunSpendBucket[]>
  loadCaptureIntent(intentKey: string): Promise<RunCaptureIntent | undefined>
  openCaptureIntent(input: {
    runId: string
    bucketKey: string
    now: number
  }): Promise<OpenRunCaptureIntent | null>
  commitCaptureSuccess(input: {
    intentKey: string
    bucketKey: string
    runId: string
    amount: number
    updatedAt: number
  }): Promise<void>
  markCaptureFailure(input: {
    intentKey: string
    status: CaptureFailureStatus
    attemptCount: number
    lastError: string
    updatedAt: number
  }): Promise<void>
  listRetryableCaptureIntents(): Promise<RunCaptureIntent[]>
  hasUnresolvedCaptureIntents(runId: string): Promise<boolean>
  hasCaptureableSpend(runId: string): Promise<boolean>
  findAbandonedCaptureIntents(runId: string): Promise<RunCaptureIntent[]>
  findRunningRunsPastExpiry(now: number): Promise<RunState[]>
  findNextExpirationAlarmAt(now: number): Promise<number | null>
  closeRun(input: {
    runId: string
    status: EndRunInput["status"]
    endedAt: number
    reconciliationNeeded: boolean
  }): Promise<void>
  markExpiredRunFinalized(runId: string): Promise<void>
}

/** A fresh service graph is required for every external wallet operation. */
export type RunBudgetWalletOps = {
  createReservation(
    input: CreateReservationInput
  ): Promise<Result<CreateReservationOutput, UnPriceWalletError>>
  captureReservationUsage(
    input: CaptureReservationUsageInput
  ): Promise<Result<CaptureReservationUsageOutput, UnPriceWalletError>>
  releaseReservation(
    input: ReleaseReservationInput
  ): Promise<Result<ReleaseReservationOutput, UnPriceWalletError>>
}

export type RunBudgetWalletFactory = {
  create(): Promise<RunBudgetWalletOps>
}

export type RunBudgetPricingInput = Pick<
  ApplyInput,
  "customerId" | "entitlement" | "event" | "grants" | "idempotencyKey" | "now" | "projectId"
> & {
  customerEntitlementId: string
  enforceLimit: true
  wallet: Extract<NonNullable<ApplyInput["wallet"]>, { mode: "external_reservation" }>
}

export type RunBudgetMeterFact = z.infer<typeof entitlementMeterFactSchemaV1>

export type RunBudgetPricingResult = Omit<ApplyResult, "meterFacts"> & {
  meterFacts: RunBudgetMeterFact[]
}

export type RunBudgetPricingDelegate = {
  apply(input: RunBudgetPricingInput): Promise<RunBudgetPricingResult>
}

export type RunBudgetScheduler = {
  getAlarm(): Promise<number | null>
  setAlarm(at: number): Promise<void>
}

export type RunBudgetClock = {
  now(): number
}

export type RunBudgetLogger = {
  error(message: string, fields: Record<string, unknown>): void
}

export type RunBudgetProcessorDeps = {
  clock: RunBudgetClock
  logger: RunBudgetLogger
  pricing: RunBudgetPricingDelegate
  scheduler: RunBudgetScheduler
  store: RunBudgetStore
  wallet: RunBudgetWalletFactory
}
