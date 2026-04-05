import { type Database, and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { Feature } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toErrorContext } from "../utils/log-context"

export class FeatureService {
  private readonly db: Database
  private readonly logger: Logger

  constructor({
    db,
    logger,
  }: {
    db: Database
    logger: Logger
  }) {
    this.db = db
    this.logger = logger
  }

  public async createFeatureRecord({
    projectId,
    slug,
    title,
    description,
    unitOfMeasure,
    meterConfig,
  }: {
    projectId: string
    slug: Feature["slug"]
    title: Feature["title"]
    description?: Feature["description"]
    unitOfMeasure?: Feature["unitOfMeasure"]
    meterConfig?: Feature["meterConfig"]
  }): Promise<Result<Feature, FetchError>> {
    const { val, err } = await wrapResult(
      this.db
        .insert(schema.features)
        .values({
          id: newId("feature"),
          slug,
          title,
          projectId,
          description,
          unitOfMeasure,
          meterConfig: meterConfig ?? null,
        })
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error creating feature record: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error creating feature record", {
        error: toErrorContext(err),
        projectId,
        slug,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "Error creating feature",
          retry: false,
        })
      )
    }

    return Ok(val as Feature)
  }

  public async removeFeatureById({
    projectId,
    id,
  }: {
    projectId: string
    id: string
  }): Promise<Result<{ state: "not_found" } | { state: "ok"; feature: Feature }, FetchError>> {
    const { val, err } = await wrapResult(
      this.db
        .delete(schema.features)
        .where(and(eq(schema.features.projectId, projectId), eq(schema.features.id, id)))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error removing feature: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error removing feature", {
        error: toErrorContext(err),
        projectId,
        featureId: id,
      })
      return Err(err)
    }

    if (!val) {
      return Ok({
        state: "not_found",
      })
    }

    return Ok({
      state: "ok",
      feature: val as Feature,
    })
  }

  public async featureExistsBySlug({
    projectId,
    slug,
  }: {
    projectId: string
    slug: string
  }): Promise<Result<boolean, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.features.findFirst({
        columns: {
          id: true,
        },
        where: (feature, { eq, and }) =>
          and(eq(feature.projectId, projectId), eq(feature.slug, slug)),
      }),
      (error) =>
        new FetchError({
          message: `error checking feature existence by slug: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error checking feature existence by slug", {
        error: toErrorContext(err),
        projectId,
      })
      return Err(err)
    }

    return Ok(Boolean(val))
  }

  public async getFeatureById({
    projectId,
    featureId,
  }: {
    projectId: string
    featureId: string
  }): Promise<Result<Feature | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.features.findFirst({
        where: (feature, { eq, and }) =>
          and(eq(feature.projectId, projectId), eq(feature.id, featureId)),
      }),
      (error) =>
        new FetchError({
          message: `error getting feature by id: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting feature by id", {
        error: toErrorContext(err),
        projectId,
        featureId,
      })
      return Err(err)
    }

    return Ok((val as Feature | null) ?? null)
  }

  public async getFeatureBySlug({
    projectId,
    slug,
  }: {
    projectId: string
    slug: string
  }): Promise<Result<Feature | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.features.findFirst({
        where: (feature, { eq, and }) =>
          and(eq(feature.projectId, projectId), eq(feature.slug, slug)),
      }),
      (error) =>
        new FetchError({
          message: `error getting feature by slug: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting feature by slug", {
        error: toErrorContext(err),
        projectId,
        slug,
      })
      return Err(err)
    }

    return Ok((val as Feature | null) ?? null)
  }

  public async searchFeaturesByProject({
    projectId,
    search,
  }: {
    projectId: string
    search?: string
  }): Promise<Result<Feature[], FetchError>> {
    const filter = `%${search}%`

    const { val, err } = await wrapResult(
      this.db.query.features.findMany({
        where: (feature, { eq, and, or, ilike }) =>
          and(
            eq(feature.projectId, projectId),
            or(ilike(feature.slug, filter), ilike(feature.title, filter))
          ),
        orderBy: (feature, { desc }) => [desc(feature.updatedAtM), desc(feature.title)],
      }),
      (error) =>
        new FetchError({
          message: `error searching features by project: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error searching features by project", {
        error: toErrorContext(err),
        projectId,
      })
      return Err(err)
    }

    return Ok(val as Feature[])
  }

  public async listFeaturesByProject({
    projectId,
  }: {
    projectId: string
  }): Promise<Result<Feature[], FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.features.findMany({
        where: (feature, { eq }) => eq(feature.projectId, projectId),
        orderBy: (feature, { desc }) => [desc(feature.createdAtM)],
      }),
      (error) =>
        new FetchError({
          message: `error listing features by project: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error listing features by project", {
        error: toErrorContext(err),
        projectId,
      })
      return Err(err)
    }

    return Ok(val as Feature[])
  }

  public async updateFeatureRecord({
    projectId,
    id,
    title,
    description,
    unitOfMeasure,
    meterConfig,
    hasMeterConfig,
  }: {
    projectId: string
    id: string
    title: Feature["title"]
    description?: Feature["description"]
    unitOfMeasure?: Feature["unitOfMeasure"]
    meterConfig?: Feature["meterConfig"]
    hasMeterConfig: boolean
  }): Promise<Result<{ state: "not_found" } | { state: "ok"; feature: Feature }, FetchError>> {
    const featureData = await this.db.query.features.findFirst({
      where: (feature, { eq, and }) => and(eq(feature.id, id), eq(feature.projectId, projectId)),
    })

    if (!featureData?.id) {
      return Ok({
        state: "not_found",
      })
    }

    const { val, err } = await wrapResult(
      this.db
        .update(schema.features)
        .set({
          title,
          description: description ?? "",
          unitOfMeasure: unitOfMeasure ?? "",
          ...(hasMeterConfig && { meterConfig: meterConfig ?? null }),
          updatedAtM: Date.now(),
        })
        .where(and(eq(schema.features.id, id), eq(schema.features.projectId, projectId)))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error updating feature record: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error updating feature record", {
        error: toErrorContext(err),
        projectId,
        featureId: id,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "Error updating feature",
          retry: false,
        })
      )
    }

    return Ok({
      state: "ok",
      feature: val as Feature,
    })
  }
}
