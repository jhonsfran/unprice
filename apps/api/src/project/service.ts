import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import type { Cache } from "@unprice/services/cache"
import type { Metrics } from "@unprice/services/metrics"
import { ProjectService } from "@unprice/services/projects"
import type { GetProjectFeaturesRequest, GetProjectFeaturesResponse } from "./interface"

export class ApiProjectService {
  private readonly logger: Logger
  private readonly metrics: Metrics
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly db: Database
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private readonly projectService: ProjectService

  constructor(opts: {
    requestId: string
    domain?: string
    logger: Logger
    metrics: Metrics
    analytics: Analytics
    cache: Cache
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    db: Database
  }) {
    this.logger = opts.logger
    this.metrics = opts.metrics
    this.analytics = opts.analytics
    this.cache = opts.cache
    this.db = opts.db
    this.waitUntil = opts.waitUntil
    this.projectService = new ProjectService({
      logger: this.logger,
      analytics: this.analytics,
      waitUntil: this.waitUntil,
      cache: this.cache,
      metrics: this.metrics,
      db: this.db,
    })
  }

  public async getProjectFeatures(
    req: GetProjectFeaturesRequest
  ): Promise<GetProjectFeaturesResponse> {
    const { projectId } = req

    const { err, val } = await this.projectService.getProjectFeatures({
      projectId,
      opts: {
        skipCache: false,
      },
    })

    if (err) {
      throw err
    }

    if (!val) {
      return {
        features: [],
      }
    }

    return {
      features: val.features,
    }
  }
}
