import type { Analytics } from "@unprice/analytics"
import { type Database, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import type {
  PaymentProvider,
  PaymentProviderConfig,
  Project,
  Workspace,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ProjectFeatureCache } from "../cache"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { cachedQuery } from "../utils/cached-query"
import { toErrorContext } from "../utils/log-context"
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
    const features = await this.db.query.features.findMany({
      with: {
        project: {
          columns: {
            enabled: true,
          },
        },
      },
      where: (feature, { eq }) => eq(feature.projectId, projectId),
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
    const { val, err } = await cachedQuery({
      skipCache: opts?.skipCache,
      cache: this.cache.projectFeatures,
      cacheKey: `${projectId}`,
      load: () =>
        this.getFeaturesDataProject({
          projectId,
        }),
      wrapLoadError: (err) =>
        new FetchError({
          message: `unable to query features from db, ${err.message}`,
          retry: false,
          context: {
            error: err.message,
            url: "",
            projectId,
            method: "getActiveFeatures",
          },
        }),
      onRetry: (attempt, err) => {
        this.logger.warn("Failed to fetch features data from cache, retrying...", {
          projectId,
          attempt,
          error: toErrorContext(err),
        })
      },
    })

    if (err) {
      this.logger.error("error getting project features", {
        error: toErrorContext(err),
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

  public async getProjectByIdInWorkspace({
    workspaceId,
    projectId,
  }: {
    workspaceId: string
    projectId: string
  }): Promise<Result<(Project & { workspace: Workspace }) | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.projects.findFirst({
        with: {
          workspace: true,
        },
        where: (project, { eq, and }) =>
          and(eq(project.slug, projectId), eq(project.workspaceId, workspaceId)),
      }),
      (error) =>
        new FetchError({
          message: `error getting project by id: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting project by id", {
        error: toErrorContext(err),
        workspaceId,
        projectId,
      })
      return Err(err)
    }

    return Ok((val as (Project & { workspace: Workspace }) | null) ?? null)
  }

  public async getMainProject(): Promise<Result<Project | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.projects.findFirst({
        where: eq(schema.projects.isMain, true),
      }),
      (error) =>
        new FetchError({
          message: `error getting main project: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting main project", {
        error: toErrorContext(err),
      })
      return Err(err)
    }

    return Ok((val as Project | null) ?? null)
  }

  public async getMainProjectBySlug({
    slug,
  }: {
    slug: string
  }): Promise<Result<Project | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.projects.findFirst({
        where: (project, { eq, and }) => and(eq(project.isMain, true), eq(project.slug, slug)),
      }),
      (error) =>
        new FetchError({
          message: `error getting main project by slug: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting main project by slug", {
        error: toErrorContext(err),
        slug,
      })
      return Err(err)
    }

    return Ok((val as Project | null) ?? null)
  }

  public async getProjectBySlugInWorkspace({
    workspaceId,
    slug,
  }: {
    workspaceId: string
    slug: string
  }): Promise<Result<(Project & { workspace: Workspace }) | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.projects.findFirst({
        with: {
          workspace: true,
        },
        where: (project, { eq, and }) =>
          and(eq(project.slug, slug), eq(project.workspaceId, workspaceId)),
      }),
      (error) =>
        new FetchError({
          message: `error getting project by slug: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting project by slug", {
        error: toErrorContext(err),
        workspaceId,
        slug,
      })
      return Err(err)
    }

    return Ok((val as (Project & { workspace: Workspace }) | null) ?? null)
  }

  public async listProjectsByWorkspace({
    workspaceId,
  }: {
    workspaceId: string
  }): Promise<
    Result<Array<Project & { workspace: Pick<Workspace, "slug" | "plan"> }>, FetchError>
  > {
    const { val, err } = await wrapResult(
      this.db.query.workspaces.findFirst({
        with: {
          projects: {
            orderBy: (project, { asc }) => [asc(project.createdAtM)],
          },
        },
        where: (workspace, { eq }) => eq(workspace.id, workspaceId),
      }),
      (error) =>
        new FetchError({
          message: `error listing projects by workspace: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error listing projects by workspace", {
        error: toErrorContext(err),
        workspaceId,
      })
      return Err(err)
    }

    if (!val) {
      return Ok([])
    }

    const { projects, ...rest } = val
    const workspace = {
      slug: rest.slug,
      plan: rest.plan,
    }

    return Ok(
      projects.map((project) => ({
        ...project,
        workspace,
      }))
    )
  }

  public async listActiveWorkspaceProjects({
    workspaceId,
  }: {
    workspaceId: string
  }): Promise<Result<Array<Project & { workspace: Pick<Workspace, "slug"> }>, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.workspaces.findFirst({
        with: {
          projects: {
            orderBy: (project, { desc }) => [desc(project.createdAtM)],
          },
        },
        where: (workspace, { eq }) => eq(workspace.id, workspaceId),
      }),
      (error) =>
        new FetchError({
          message: `error listing active workspace projects: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error listing active workspace projects", {
        error: toErrorContext(err),
        workspaceId,
      })
      return Err(err)
    }

    if (!val) {
      return Ok([])
    }

    const { projects, ...rest } = val
    const workspace = {
      slug: rest.slug,
    }

    return Ok(
      projects.map((project) => ({
        ...project,
        workspace,
      }))
    )
  }

  public async updateProjectRecord({
    id,
    name,
    defaultCurrency,
    timezone,
    url,
    contactEmail,
  }: {
    id: string
    name?: Project["name"]
    defaultCurrency?: Project["defaultCurrency"]
    timezone?: Project["timezone"]
    url?: Project["url"]
    contactEmail?: Project["contactEmail"]
  }): Promise<Result<{ state: "not_found" } | { state: "ok"; project: Project }, FetchError>> {
    const projectData = await this.db.query.projects.findFirst({
      where: (project, { eq }) => eq(project.id, id),
    })

    if (!projectData?.id) {
      return Ok({ state: "not_found" })
    }

    const { val, err } = await wrapResult(
      this.db
        .update(schema.projects)
        .set({
          name,
          defaultCurrency,
          timezone,
          url,
          contactEmail,
        })
        .where(eq(schema.projects.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error updating project record: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error updating project record", {
        error: toErrorContext(err),
        projectId: id,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "error updating project",
          retry: false,
        })
      )
    }

    return Ok({
      state: "ok",
      project: val as Project,
    })
  }

  public async getPaymentProviderConfig({
    projectId,
    paymentProvider,
  }: {
    projectId: string
    paymentProvider: PaymentProvider
  }): Promise<Result<PaymentProviderConfig | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.paymentProviderConfig.findFirst({
        where: (table, { eq, and }) =>
          and(
            eq(table.projectId, projectId),
            eq(table.paymentProvider, paymentProvider),
            eq(table.active, true)
          ),
      }),
      (error) =>
        new FetchError({
          message: `error getting payment provider config: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting payment provider config", {
        error: toErrorContext(err),
        projectId,
        paymentProvider,
      })
      return Err(err)
    }

    return Ok((val as PaymentProviderConfig | null) ?? null)
  }
}
