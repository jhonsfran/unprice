import { type Database, and, eq } from "@unprice/db"
import { domains as domainsTable } from "@unprice/db/schema"
import type { Domain } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toErrorContext } from "../utils/log-context"

export class DomainService {
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

  public async domainExistsByName({
    name,
  }: {
    name: string
  }): Promise<Result<boolean, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.domains.findFirst({
        columns: {
          id: true,
        },
        where: (domain, { eq }) => eq(domain.name, name),
      }),
      (error) =>
        new FetchError({
          message: `error checking domain existence: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error checking domain existence", {
        error: toErrorContext(err),
        name,
      })
      return Err(err)
    }

    return Ok(Boolean(val))
  }

  public async listDomainsByWorkspace({
    workspaceId,
  }: {
    workspaceId: string
  }): Promise<Result<Domain[], FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.domains.findMany({
        where: (domain, { eq }) => eq(domain.workspaceId, workspaceId),
      }),
      (error) =>
        new FetchError({
          message: `error listing domains by workspace: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error listing domains by workspace", {
        error: toErrorContext(err),
        workspaceId,
      })
      return Err(err)
    }

    return Ok(val as Domain[])
  }

  public async getDomainById({
    domainId,
    workspaceId,
  }: {
    domainId: string
    workspaceId: string
  }): Promise<Result<Domain | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.domains.findFirst({
        where: (domain, { eq, and }) =>
          and(eq(domain.id, domainId), eq(domain.workspaceId, workspaceId)),
      }),
      (error) =>
        new FetchError({
          message: `error getting domain by id: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting domain by id", {
        error: toErrorContext(err),
        domainId,
        workspaceId,
      })
      return Err(err)
    }

    return Ok((val as Domain | null) ?? null)
  }

  public async createDomain({
    domainId,
    name,
    apexName,
    workspaceId,
  }: {
    domainId: string
    name: string
    apexName: string
    workspaceId: string
  }): Promise<Result<Domain | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db
        .insert(domainsTable)
        .values({
          id: domainId,
          name,
          apexName,
          workspaceId,
        })
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error creating domain: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error creating domain", {
        error: toErrorContext(err),
        domainId,
        workspaceId,
      })
      return Err(err)
    }

    return Ok((val as Domain | null) ?? null)
  }

  public async updateDomainName({
    domainId,
    workspaceId,
    name,
  }: {
    domainId: string
    workspaceId: string
    name: string
  }): Promise<Result<Domain | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db
        .update(domainsTable)
        .set({
          name,
        })
        .where(and(eq(domainsTable.id, domainId), eq(domainsTable.workspaceId, workspaceId)))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error updating domain: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error updating domain", {
        error: toErrorContext(err),
        domainId,
        workspaceId,
      })
      return Err(err)
    }

    return Ok((val as Domain | null) ?? null)
  }

  public async removeDomainById({
    domainId,
  }: {
    domainId: string
  }): Promise<Result<Domain | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db
        .delete(domainsTable)
        .where(eq(domainsTable.id, domainId))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error removing domain: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error removing domain", {
        error: toErrorContext(err),
        domainId,
      })
      return Err(err)
    }

    return Ok((val as Domain | null) ?? null)
  }
}
