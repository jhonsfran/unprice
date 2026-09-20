import { TRPCError } from "@trpc/server"

const PAYMENT_PROVIDER_PUBLISH_MESSAGE =
  "The plan's payment provider is not configured or enabled. Configure it in payment settings before publishing this paid plan."

export function paymentProviderPublishError(): TRPCError {
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: PAYMENT_PROVIDER_PUBLISH_MESSAGE,
  })
}
