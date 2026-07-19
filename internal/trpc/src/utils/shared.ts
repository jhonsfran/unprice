import { signOutCustomer as signOutCustomerUseCase } from "@unprice/services/use-cases"

import type { Context } from "#trpc"

export const signOutCustomer = async ({
  input,
  ctx,
}: {
  input: { customerId: string; projectId: string }
  ctx: Context
}): Promise<{ success: boolean; message?: string }> => {
  const { customerId, projectId } = input

  const { err, val } = await signOutCustomerUseCase(
    { services: ctx.services, logger: ctx.logger },
    { customerId, projectId, now: Date.now() }
  )

  if (err) {
    return {
      success: false,
      message: err.message,
    }
  }

  return val
}
