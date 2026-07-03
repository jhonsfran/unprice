import type { Context } from "#trpc"

export const signOutCustomer = async ({
  input,
  ctx,
}: {
  input: { customerId: string; projectId: string }
  ctx: Context
}) => {
  const { customerId, projectId } = input

  const { customers } = ctx.services

  const { err, val } = await customers.signOut({
    customerId: customerId,
    projectId: projectId,
  })

  if (err) {
    return {
      success: false,
      message: err.message,
    }
  }

  return val
}
