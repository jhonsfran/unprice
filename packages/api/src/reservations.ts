import type { GeneratedSdkResources } from "./generated/sdk-resources"
import type { OperationInput, OperationResponse } from "./operation-types"
import type { ApiResult } from "./result"

type RunResources = GeneratedSdkResources["runs"]
type RunSummary = OperationResponse<"runs.start">

export type ReserveInput = {
  customerId?: string
  maximumAmountMinor: number
  idempotencyKey: string
  /** Epoch milliseconds. Defaults to one hour after start and cannot exceed 24 hours after start. */
  expiresAt?: number | null
}

export type SettleReservationInput = Omit<OperationInput<"runs.settle">, "runId" | "idempotencyKey">

export type ReservationSettlement = OperationResponse<"runs.settle">

export type Reservation = {
  readonly id: string
  readonly customerId: string
  readonly currency: string
  readonly maximumAmountMinor: number
  settle(input: SettleReservationInput): Promise<ApiResult<ReservationSettlement>>
  release(): Promise<ApiResult<OperationResponse<"runs.end">>>
}

export type Reservations = {
  reserve(input: ReserveInput): Promise<ApiResult<Reservation>>
}

class RunReservation implements Reservation {
  public readonly id: string
  public readonly customerId: string
  public readonly currency: string
  public readonly maximumAmountMinor: number

  constructor(
    private readonly runs: RunResources,
    private readonly idempotencyKey: string,
    summary: RunSummary
  ) {
    this.id = summary.runId
    this.customerId = summary.customerId
    this.currency = summary.currency
    this.maximumAmountMinor = summary.budgetAmountMinor
  }

  async settle(input: SettleReservationInput): Promise<ApiResult<ReservationSettlement>> {
    const settlement = await this.runs.settle({
      ...input,
      runId: this.id,
      idempotencyKey: `${this.idempotencyKey}:settle`,
    })

    if (settlement.error) {
      return { error: settlement.error }
    }

    const accepted = settlement.result.accepted || settlement.result.reason === "duplicate"
    const ended = await this.runs.end({
      runId: this.id,
      status: accepted ? "completed" : "failed",
    })

    if (ended.error) {
      return { error: ended.error }
    }

    return {
      result: {
        ...settlement.result,
        run: ended.result,
      },
    }
  }

  release(): Promise<ApiResult<OperationResponse<"runs.end">>> {
    return this.runs.end({ runId: this.id, status: "canceled" })
  }
}

export const createReservations = (runs: RunResources): Reservations => ({
  reserve: async ({ maximumAmountMinor, ...input }) => {
    const started = await runs.start({
      ...input,
      budgetAmountMinor: maximumAmountMinor,
    })

    if (started.error) {
      return { error: started.error }
    }

    return {
      result: new RunReservation(runs, input.idempotencyKey, started.result),
    }
  },
})
