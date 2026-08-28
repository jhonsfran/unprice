type EntitlementLimitInput = {
  configuredLimit: number | null
  featureType: "flat" | "tier" | "package" | "usage"
  grants: ReadonlyArray<{ allowanceUnits: number | null }>
}

export function resolveEntitlementLimit({
  configuredLimit,
  featureType,
  grants,
}: EntitlementLimitInput): number | null {
  const grantAllowance = sumGrantAllowance(grants)

  return featureType === "tier" || featureType === "package"
    ? grantAllowance
    : (configuredLimit ?? grantAllowance)
}

export function sumGrantAllowance(
  grants: ReadonlyArray<{ allowanceUnits: number | null }>
): number | null {
  if (grants.length === 0) {
    return null
  }

  let total = 0

  for (const grant of grants) {
    if (grant.allowanceUnits === null) {
      return null
    }

    total += grant.allowanceUnits
  }

  return total
}
