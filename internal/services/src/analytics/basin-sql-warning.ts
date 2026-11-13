import type { Logger } from "@unprice/logs"

let warned = false

/** Web and journal polling share one warning when Basin SQL is not configured. */
export function warnBasinSqlNotConfigured(logger: Logger, message: string, context: string) {
  if (warned) return
  warned = true
  logger.warn(`Basin SQL reads are disabled: ${message}`, { context })
}
