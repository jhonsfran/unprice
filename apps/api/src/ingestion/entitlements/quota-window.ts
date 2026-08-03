import { computeGrantPeriodBucket } from "@unprice/services/entitlements"
import type { QuotaWindow } from "@unprice/services/ingestion"
import type { ActiveGrantInput } from "./contracts"

export function resolveSharedQuotaWindow(
  grants: readonly ActiveGrantInput[],
  timestamp: number
): QuotaWindow | null {
  const windows = grants.flatMap((grant) => {
    const window = computeGrantPeriodBucket(grant, timestamp)
    return window ? [window] : []
  })

  const [firstWindow] = windows
  if (!firstWindow || windows.length !== grants.length) {
    return null
  }

  if (
    !windows.every(
      (window) =>
        window.periodKey === firstWindow.periodKey &&
        window.start === firstWindow.start &&
        window.end === firstWindow.end
    )
  ) {
    return null
  }

  return {
    periodKey: firstWindow.periodKey,
    startAt: firstWindow.start,
    endAt: firstWindow.end === Number.MAX_SAFE_INTEGER ? null : firstWindow.end,
  }
}
