import { Analytics } from "@unprice/analytics"
import {
  createDrain,
  createStandaloneRequestLogger,
  emitWideEvent,
  initObservability,
} from "@unprice/observability"
import { CacheService } from "@unprice/services/cache"
import { NoopMetrics } from "@unprice/services/metrics"
import { env } from "../../env"
import { db } from "../db"

const drain = createDrain({
  environment: env.APP_ENV,
  token: env.AXIOM_API_TOKEN,
  dataset: env.AXIOM_DATASET,
})

initObservability({
  env: {
    service: "jobs",
    environment: env.APP_ENV,
    version: "0.1.0",
  },
  drain,
  sampling: {
    rates: {
      info: env.APP_ENV === "production" ? 10 : 100,
      warn: 100,
      error: 100,
      debug: env.APP_ENV === "production" ? 0 : 100,
    },
    keep: [{ status: 400 }, { duration: 1000 }],
  },
})

export const createContext = async ({
  taskId,
  subscriptionId,
  projectId,
  phaseId,
  defaultFields,
}: {
  taskId: string
  subscriptionId: string
  projectId: string
  phaseId?: string
  defaultFields: Record<string, string> & {
    api: string
  }
}) => {
  // don't register any stores - only memory
  const cache = new CacheService(
    {
      waitUntil: () => {},
    },
    new NoopMetrics(),
    false
  )

  cache.init([])

  const path = `/trigger/tasks/${defaultFields.api}`
  const startedAt = Date.now()
  const { logger, requestLogger } = createStandaloneRequestLogger(
    {
      method: "POST",
      path,
      requestId: taskId,
    },
    {
      flush: drain?.flush,
    }
  )

  logger.set({
    request: {
      id: taskId,
      timestamp: new Date(startedAt).toISOString(),
      method: "POST",
      path,
      host: "trigger.dev",
      protocol: "https",
    },
    business: {
      project_id: projectId,
      operation: defaultFields.api,
    },
    task: {
      ...defaultFields,
      phaseId,
      projectId,
      requestId: taskId,
      subscriptionId,
    },
  })

  const analytics = new Analytics({
    emit: true,
    tinybirdToken: env.TINYBIRD_TOKEN,
    tinybirdUrl: env.TINYBIRD_URL,
    logger: logger,
  })

  return {
    waitUntil: () => {},
    headers: new Headers(),
    session: null,
    activeWorkspaceSlug: "",
    activeProjectSlug: "",
    ip: "background-jobs",
    requestId: taskId,
    logger,
    requestLogger,
    metrics: new NoopMetrics(),
    cache: cache.getCache(),
    db: db,
    analytics,
    flushLogs: async (status = 200) => {
      const duration = Math.max(0, Date.now() - startedAt)
      requestLogger.set({
        status,
        duration,
        request: {
          status,
          duration,
        },
      })

      emitWideEvent(requestLogger, {
        status,
        duration,
        request: {
          status,
          duration,
        },
      })

      await logger.flush()
    },
  }
}
