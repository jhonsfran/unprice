"use server"

import { getRequestLoggers, withEvlog } from "~/lib/evlog"

export const logError = withEvlog(async (error: Error | string, errorInfo?: unknown) => {
  const message = typeof error === "string" ? error : error.message
  const requestId = `global-error-${Date.now().toString()}`
  const { logger } = getRequestLoggers(requestId)

  logger.error(message, {
    errorInfo: errorInfo as Record<string, unknown> | undefined,
  })

  await logger.flush()
})
