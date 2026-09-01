import type { RouterOutputs } from "@unprice/trpc/routes"

type CurrentAccess = RouterOutputs["customers"]["getCurrentAccess"]
type CurrentEntitlements = RouterOutputs["customers"]["getCurrentEntitlements"]

export function mergeCurrentEntitlements(
  access: CurrentAccess,
  current: CurrentEntitlements
): {
  access: CurrentAccess
  unavailableEntitlementIds: ReadonlySet<string>
} {
  const currentById = new Map(
    current.entitlements.map((entitlement) => [entitlement.id, entitlement])
  )
  const unavailableEntitlementIds = new Set(
    current.entitlements
      .filter((entitlement) => entitlement.status === "unavailable")
      .map((entitlement) => entitlement.id)
  )

  for (const entitlement of access.entitlements) {
    if (entitlement.featureType === "usage" && !currentById.has(entitlement.id)) {
      unavailableEntitlementIds.add(entitlement.id)
    }
  }

  return {
    access: {
      ...access,
      generatedAt: current.generatedAt,
      usageUnavailable: false,
      entitlements: access.entitlements.map((entitlement) => {
        const live = currentById.get(entitlement.id)
        if (!live || live.status === "unavailable") {
          return entitlement
        }

        return {
          ...entitlement,
          limit: live.limit,
          currentUsage: live.usage ?? null,
          usagePercent: live.usagePercent ?? null,
          usagePeriods: live.quotaWindow
            ? [
                {
                  periodKey: live.quotaWindow.periodKey,
                  start: live.quotaWindow.startAt,
                  end: live.quotaWindow.endAt ?? Number.MAX_SAFE_INTEGER,
                },
              ]
            : entitlement.usagePeriods,
        }
      }),
    },
    unavailableEntitlementIds,
  }
}
