// Human label for a billing cadence. Never surface the raw config name
// (e.g. "every-15-minutes") on money screens.
export function formatBillingLabel(config: {
  billingInterval: string
  billingIntervalCount?: number | null
}): string {
  const count = config.billingIntervalCount ?? 1

  if (config.billingInterval === "onetime") {
    return "one-time"
  }

  if (count === 1) {
    switch (config.billingInterval) {
      case "month":
        return "monthly"
      case "year":
        return "yearly"
      case "week":
        return "weekly"
      case "day":
        return "daily"
      default:
        return `every ${config.billingInterval}`
    }
  }

  return `every ${count} ${config.billingInterval}s`
}
