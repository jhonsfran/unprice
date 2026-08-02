import { log as evlog } from "evlog"
import { useLogger } from "evlog/next"

type WarningCode =
  | "debug-enabled"
  | "csrf-disabled"
  | "experimental-webauthn"
  | "env-url-basepath-redundant"
  | "env-url-basepath-mismatch"

function tryUseRequestLogger() {
  try {
    return useLogger<Record<string, unknown>>()
  } catch {
    return null
  }
}

export const authLogger = {
  debug(message: string) {
    const logger = tryUseRequestLogger()

    if (logger) {
      logger.info(message)
      return
    }

    evlog.debug({
      message,
    })
  },
  error(error: Error) {
    const logger = tryUseRequestLogger()

    if (logger) {
      logger.error(error)
      return
    }

    evlog.error({
      error,
    })
  },
  warn(code: WarningCode) {
    if (code === "experimental-webauthn") {
      return
    }

    const logger = tryUseRequestLogger()

    if (logger) {
      logger.warn(code, {
        auth_warning: code,
      })
      return
    }

    evlog.warn({
      message: code,
      auth_warning: code,
    })
  },
}
