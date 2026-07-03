import { TRPCError } from "@trpc/server"

export function toSubscriptionMachineTrpcError(error: { message: string }): TRPCError {
  if (error.message === "SUBSCRIPTION_BUSY") {
    return new TRPCError({
      code: "CONFLICT",
      message: "Subscription is already being updated",
    })
  }

  if (isExpectedSubscriptionMachineRejection(error.message)) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message: error.message,
    })
  }

  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: error.message,
  })
}

function isExpectedSubscriptionMachineRejection(message: string): boolean {
  return (
    message.startsWith("Cannot renew subscription") ||
    message.startsWith("Cannot end trial") ||
    message.startsWith("Cannot invoice wallet-only subscription") ||
    message.startsWith("Cannot invoice subscription") ||
    message === "Subscription is not active"
  )
}
