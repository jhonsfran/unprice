import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ProjectFeatureCache } from "../cache"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { toErrorContext } from "../utils/log-context"
import { retry } from "../utils/retry"
import { UnPriceProjectError } from "./errors"

export class ProjectService {
  private readonly db: Database
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly metrics: Metrics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  constructor({
    db,
    logger,
    analytics,
    waitUntil,
    cache,
    metrics,
  }: {
    db: Database
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
  }) {
    this.db = db
    this.logger = logger
    this.analytics = analytics
    this.waitUntil = waitUntil
    this.cache = cache
    this.metrics = metrics
  }

  private async getFeaturesDataProject({
    projectId,
  }: {
    projectId: string
  }): Promise<ProjectFeatureCache | null> {
    const start = performance.now()

    // if not found in DO, then we query the db
    const features = await this.db.query.features
      .findMany({
        with: {
          project: {
            columns: {
              enabled: true,
            },
          },
        },
        where: (feature, { eq }) => eq(feature.projectId, projectId),
      })
      .catch((err) => {
        this.logger.set({ error: toErrorContext(err) })
        throw err
      })

    const end = performance.now()

    this.metrics.emit({
      metric: "metric.db.read",
      query: "getActiveFeatures",
      duration: end - start,
      service: "customer",
      projectId,
    })

    if (features.length === 0) {
      return null
    }

    const project = features[0]!.project ?? false

    if (!project) {
      return null
    }

    return {
      project,
      features: features,
    }
  }

  public async getProjectFeatures({
    projectId,
    opts,
  }: {
    projectId: string
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
    }
  }): Promise<Result<ProjectFeatureCache | null, FetchError | UnPriceProjectError>> {
    // first try to get the entitlement from cache, if not found try to get it from DO,
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getFeaturesDataProject({
            projectId,
          }),
          (err) =>
            new FetchError({
              message: `unable to query features from db, ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                projectId,
                method: "getActiveFeatures",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.projectFeatures.swr(`${projectId}`, () =>
              this.getFeaturesDataProject({
                projectId,
              })
            ),
          (attempt, err) => {
            this.logger.warn("Failed to fetch features data from cache, retrying...", {
              projectId,
              attempt,
              error: err.message,
            })
          }
        )

    if (err) {
      this.logger.error("error getting project features", {
        error: err.message,
      })

      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    if (!val) {
      return Ok(null)
    }

    // check if the project is enabled
    if (!val.project.enabled) {
      return Err(
        new UnPriceProjectError({
          code: "PROJECT_NOT_ENABLED",
          message: "Project is not enabled",
        })
      )
    }

    return Ok(val)
  }
}
