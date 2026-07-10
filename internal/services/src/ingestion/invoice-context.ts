import type { IngestionCandidateEntitlements } from "./entitlement-context"
import type { IngestionQueueMessage } from "./message"

type CatchUpProcessor = {
  catchUpForPreparedGroup(params: {
    candidateEntitlements: IngestionCandidateEntitlements
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<{ changed: boolean; caughtUpSubscriptionIds: string[] }>
}

/**
 * The one place that owns the ingestion invariant: after a subscription
 * catch-up changed anything (renewal, wallet activation, billing-period
 * materialization), the entitlement/billing context MUST be reloaded before
 * any further routing or apply. Callers decide WHETHER to attempt catch-up;
 * this helper guarantees the reload-on-change contract.
 */
export async function catchUpAndReloadContext<TContext>(params: {
  candidateEntitlements: IngestionCandidateEntitlements
  catchUp: CatchUpProcessor | undefined
  current: TContext
  customerId: string
  messages: IngestionQueueMessage[]
  projectId: string
  reload: () => Promise<TContext>
}): Promise<{ changed: boolean; context: TContext }> {
  if (!params.catchUp) {
    return { changed: false, context: params.current }
  }

  const result = await params.catchUp.catchUpForPreparedGroup({
    candidateEntitlements: params.candidateEntitlements,
    customerId: params.customerId,
    messages: params.messages,
    projectId: params.projectId,
  })

  if (!result.changed) {
    return { changed: false, context: params.current }
  }

  return { changed: true, context: await params.reload() }
}
