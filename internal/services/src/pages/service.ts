import { type Database, and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import type { Page } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toErrorContext } from "../utils/log-context"

export class PageService {
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

  public async getPageById({
    projectId,
    pageId,
  }: {
    projectId: string
    pageId: string
  }): Promise<Result<Page | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.pages.findFirst({
        where: (page, { eq, and }) => and(eq(page.id, pageId), eq(page.projectId, projectId)),
      }),
      (error) =>
        new FetchError({
          message: `error getting page by id: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting page by id", {
        error: toErrorContext(err),
        projectId,
        pageId,
      })
      return Err(err)
    }

    return Ok((val as Page | null) ?? null)
  }

  public async getPageByDomain({
    domain,
  }: {
    domain: string
  }): Promise<Result<Page | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.pages.findFirst({
        where: (page, { eq, or }) => or(eq(page.customDomain, domain), eq(page.subdomain, domain)),
      }),
      (error) =>
        new FetchError({
          message: `error getting page by domain: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting page by domain", {
        error: toErrorContext(err),
        domain,
      })
      return Err(err)
    }

    return Ok((val as Page | null) ?? null)
  }

  public async listPagesByProject({
    projectId,
    fromDate,
    toDate,
  }: {
    projectId: string
    fromDate?: number
    toDate?: number
  }): Promise<Result<Page[], FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.pages.findMany({
        where: (page, { eq, and, between, gte, lte }) =>
          and(
            eq(page.projectId, projectId),
            fromDate && toDate ? between(page.createdAtM, fromDate, toDate) : undefined,
            fromDate ? gte(page.createdAtM, fromDate) : undefined,
            toDate ? lte(page.createdAtM, toDate) : undefined
          ),
        orderBy: (page, { desc }) => [desc(page.createdAtM)],
      }),
      (error) =>
        new FetchError({
          message: `error listing pages by project: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error listing pages by project", {
        error: toErrorContext(err),
        projectId,
      })
      return Err(err)
    }

    return Ok(val as Page[])
  }

  public async updatePage({
    pageId,
    projectId,
    subdomain,
    customDomain,
    title,
    name,
    description,
    logo,
    logoType,
    colorPalette,
    faqs,
    copy,
    selectedPlans,
    ctaLink,
  }: {
    pageId: string
    projectId: string
    subdomain?: Page["subdomain"]
    customDomain?: Page["customDomain"]
    title?: Page["title"]
    name?: Page["name"]
    description?: Page["description"]
    logo?: Page["logo"]
    logoType?: Page["logoType"]
    colorPalette?: Page["colorPalette"]
    faqs?: Page["faqs"]
    copy?: Page["copy"]
    selectedPlans?: Page["selectedPlans"]
    ctaLink?: Page["ctaLink"]
  }): Promise<Result<Page | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db
        .update(schema.pages)
        .set({
          subdomain,
          customDomain,
          description,
          name,
          title,
          copy,
          logo,
          colorPalette,
          faqs,
          selectedPlans,
          logoType,
          ctaLink,
          updatedAtM: Date.now(),
        })
        .where(and(eq(schema.pages.id, pageId), eq(schema.pages.projectId, projectId)))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error updating page: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error updating page", {
        error: toErrorContext(err),
        projectId,
        pageId,
      })
      return Err(err)
    }

    return Ok((val as Page | null) ?? null)
  }
}
