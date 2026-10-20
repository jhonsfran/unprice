import { budgetOperatorReasonSchema } from "@unprice/db/validators"
import type { RouterInputs } from "@unprice/trpc/routes"

// The release dialog's pure parts live here so the component file exports only
// components and Fast Refresh keeps the dialog's state across edits.

export type ReleasableHold = {
  id: string
  amount: string
  idempotencyKey: string
  createdAt: number
}

/** The release names the hold by its id and creation time, as the audit row is keyed. */
export function releaseHoldInput(
  budgetId: string,
  hold: ReleasableHold,
  reason: string
): RouterInputs["budgets"]["releaseHold"] {
  return {
    id: budgetId,
    holdId: hold.id,
    holdCreatedAt: hold.createdAt,
    reason: reason.trim(),
    confirm: true,
  }
}

/** Release needs the attestation box and a reason the server will accept. */
export function canReleaseWith(reason: string, attested: boolean): boolean {
  return attested && budgetOperatorReasonSchema.safeParse(reason).success
}
