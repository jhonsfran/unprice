import { type ServiceContext, createServiceContext } from "@unprice/services/context"
import type { ServiceDeps } from "@unprice/services/deps"

/**
 * Build the domain service graph from a tRPC context.
 *
 * tRPC contexts carry the same 6 infrastructure deps that `createServiceContext`
 * needs. This helper extracts them and delegates to the shared factory so that
 * every tRPC procedure gets a properly-wired service graph without repeating
 * the 4-line construction boilerplate.
 *
 * Usage in a procedure:
 *   const { subscriptions, billing } = createTRPCServices(ctx)
 */
export function createTRPCServices(ctx: ServiceDeps): ServiceContext {
  return createServiceContext(ctx)
}
