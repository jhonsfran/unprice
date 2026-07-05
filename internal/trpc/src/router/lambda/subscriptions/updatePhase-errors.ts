import { TRPCError } from "@trpc/server"

const expectedSubscriptionPreconditionMessages = new Set([
  "End date is in the past",
  "End date must be after the phase start date",
  "Future phases must start in the future",
  "Payment method is required for this plan version",
  "Phase is active or in the past, can't remove",
  "Phase not found",
  "Phases are not consecutive. There are other phases in the same date range.",
  "Phases overlap, there is already a phase in the same date range",
  "Plan version has no features",
  "Plan version is not active, only active versions can be subscribed to",
  "Plan version is not published, only published versions can be subscribed to",
  "Subscription is not active",
  "Subscription must be active to create a new phase. Please contact support.",
  "Subscription not found",
  "The phase is active, you can't change the start date",
  "There is already an active phase in the same date range",
  "Version not found. Please check the planVersionId",
])

export function isExpectedSubscriptionPreconditionError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === "UnPriceSubscriptionError" &&
    expectedSubscriptionPreconditionMessages.has(error.message)
  )
}

export function isExpectedBillingPreconditionError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === "UnPriceBillingError" &&
    error.message === "Subscription is not active"
  )
}

export function updatePhaseErrorToTrpcError(error: unknown): TRPCError {
  if (error instanceof Error && error.name === "SchemaError") {
    return new TRPCError({ code: "BAD_REQUEST", message: error.message })
  }

  if (isExpectedSubscriptionPreconditionError(error)) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: error.message })
  }

  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: error instanceof Error ? error.message : "Failed to update subscription phase",
  })
}
