"use server"

import { getRequestLoggers, withEvlog } from "~/lib/observability"

export type ClientErrorInfo = {
  digest?: string
  name?: string
  stack?: string
}

/**
 * Records an error caught by a client error boundary.
 *
 * `Error` instances do not survive the client → server-action boundary, so
 * boundaries send the parts by hand and we rebuild one here. Rebuilding
 * matters: handed a bare string, the logger synthesizes its own `Error`, and
 * the stack it stores is the logging call path — every client fault then gets
 * filed under the logger's own frames instead of where it happened.
 *
 * Next strips `message` and `stack` from production client boundaries and
 * leaves only `digest`; the synthesized stack is the best available then, and
 * `digest` is what ties the report back to the server-side log.
 */
export const logError = withEvlog(async (message: string, errorInfo?: ClientErrorInfo) => {
  const { logger } = getRequestLoggers()

  const error = new Error(message || "Unknown client error")

  if (errorInfo?.name) {
    error.name = errorInfo.name
  }

  if (errorInfo?.stack) {
    error.stack = errorInfo.stack
  }

  // the stack now rides on `error` itself; logging it twice just doubles the
  // size of every error event
  const { stack: _stack, ...context } = errorInfo ?? {}

  logger.error(error, { errorInfo: context })

  await logger.flush()
})
