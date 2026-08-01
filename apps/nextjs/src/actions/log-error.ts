"use server"

import { getRequestLoggers, withEvlog } from "~/lib/observability"

export const logError = withEvlog(
  async (message: string, errorInfo?: { digest?: string; name?: string }) => {
    const requestId = `global-error-${Date.now().toString()}`
    const { logger } = getRequestLoggers(requestId)

    logger.error(message, {
      errorInfo,
    })

    await logger.flush()
  }
)
