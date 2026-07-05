export const scheduledPlanChangeUnavailableReason =
  "A plan change is already scheduled. Contact support to modify it before choosing another plan."

export type PhaseTiming = {
  startAt: number
}

export function getScheduledPlanChangeUnavailableReason(
  phases: readonly PhaseTiming[],
  now: number
): string | null {
  return phases.some((phase) => phase.startAt > now) ? scheduledPlanChangeUnavailableReason : null
}
