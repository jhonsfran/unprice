import type { Logger } from "@unprice/logs"
import { log } from "evlog"
import { env } from "../env"
import { Analytics } from "./analytics"

const logger: Logger = {
  set: () => {},
  debug: (message, fields) => {
    log.debug({
      message,
      ...fields,
    })
  },
  info: (message, fields) => {
    log.info({
      message,
      ...fields,
    })
  },
  warn: (message, fields) => {
    log.warn({
      message,
      ...fields,
    })
  },
  error: (message, fields) => {
    log.error({
      message,
      ...fields,
    })
  },
  flush: async () => {},
}

export const analytics = new Analytics({
  emit: true,
  tinybirdToken: env.TINYBIRD_TOKEN,
  tinybirdUrl: env.TINYBIRD_URL,
  logger,
})
