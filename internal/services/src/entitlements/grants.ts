import { type Database, and, asc, desc, eq, gt, inArray, isNull, lte, or } from "@unprice/db"
import { grants } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type {
  CustomerEntitlementExtended,
  Grant,
  GrantExtended,
  GrantType,
  InsertGrant,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { UnPriceGrantError } from "./errors"

export const DEFAULT_GRANT_PRIORITY: Record<GrantType, number> = {
  subscription: 10,
  addon: 50,
  trial: 80,
  promotion: 90,
  manual: 100,
}

export class GrantsManager {
  private readonly db: Database
  private readonly logger: Logger

  constructor({ db, logger }: { db: Database; logger: Logger; revalidateInterval?: number }) {
    this.db = db
    this.logger = logger
  }

  private async findGrantBySourceWindow({
    db,
    grant,
  }: {
    db: Database
    grant: InsertGrant
  }) {
    return db.query.grants.findFirst({
      where: (table, { and: andOp, eq: eqOp, isNull }) =>
        andOp(
          eqOp(table.projectId, grant.projectId),
          eqOp(table.customerEntitlementId, grant.customerEntitlementId),
          eqOp(table.type, grant.type),
          eqOp(table.effectiveAt, grant.effectiveAt),
          grant.expiresAt == null ? isNull(table.expiresAt) : eqOp(table.expiresAt, grant.expiresAt)
        ),
    })
  }

  public getDefaultPriority(type: GrantType): number {
    return DEFAULT_GRANT_PRIORITY[type] ?? 0
  }

  public async createGrant(params: {
    db?: Database
    grant: InsertGrant
  }): Promise<Result<Grant, FetchError | UnPriceGrantError>> {
    const trx = params.db ?? this.db
    const grant = {
      ...params.grant,
      id: params.grant.id ?? newId("grant"),
      priority: params.grant.priority ?? this.getDefaultPriority(params.grant.type),
    }

    try {
      const inserted = await trx
        .insert(grants)
        .values(grant)
        .onConflictDoNothing({
          target: [
            grants.projectId,
            grants.customerEntitlementId,
            grants.type,
            grants.effectiveAt,
            grants.expiresAt,
          ],
        })
        .returning()
        .then((rows) => rows[0] ?? null)

      if (inserted) {
        return Ok(inserted)
      }

      const existing = await this.findGrantBySourceWindow({ db: trx, grant })

      if (!existing) {
        return Err(
          new UnPriceGrantError({
            message: "Grant conflict could not be resolved",
            subjectId: grant.customerEntitlementId,
          })
        )
      }

      return Ok(existing)
    } catch (error) {
      this.logger.error(error, {
        context: "Error creating grant",
        customerEntitlementId: grant.customerEntitlementId,
        projectId: grant.projectId,
      })

      return Err(
        new FetchError({
          message: `Failed to create grant: ${error instanceof Error ? error.message : String(error)}`,
          retry: true,
        })
      )
    }
  }

  public async listGrantsForEntitlement(params: {
    customerEntitlementId: string
    projectId: string
    now?: number
    startAt?: number
    endAt?: number
    db?: Database
  }): Promise<Result<Grant[], FetchError>> {
    const trx = params.db ?? this.db
    const maxEffectiveAt = params.startAt !== undefined ? params.endAt : params.now
    const minExpiresAt = params.startAt !== undefined ? params.startAt : params.now

    try {
      const rows = await trx.query.grants.findMany({
        where: (grant, { and: andOp, eq: eqOp, gt, isNull, lte, or }) =>
          andOp(
            eqOp(grant.projectId, params.projectId),
            eqOp(grant.customerEntitlementId, params.customerEntitlementId),
            maxEffectiveAt === undefined ? undefined : lte(grant.effectiveAt, maxEffectiveAt),
            minExpiresAt === undefined
              ? undefined
              : or(isNull(grant.expiresAt), gt(grant.expiresAt, minExpiresAt))
          ),
        orderBy: (grant, { asc, desc }) => [
          desc(grant.priority),
          asc(grant.expiresAt),
          asc(grant.id),
        ],
      })

      return Ok(rows)
    } catch (error) {
      this.logger.error(error, {
        context: "Error listing grants for entitlement",
        customerEntitlementId: params.customerEntitlementId,
        projectId: params.projectId,
      })

      return Err(
        new FetchError({
          message: `Failed to list grants: ${error instanceof Error ? error.message : String(error)}`,
          retry: true,
        })
      )
    }
  }

  public async listGrantsForEntitlements(params: {
    customerEntitlementIds: string[]
    projectId: string
    now?: number
    startAt?: number
    endAt?: number
    db?: Database
  }): Promise<Result<Grant[], FetchError>> {
    const trx = params.db ?? this.db

    if (params.customerEntitlementIds.length === 0) {
      return Ok([])
    }

    const maxEffectiveAt = params.startAt !== undefined ? params.endAt : params.now
    const minExpiresAt = params.startAt !== undefined ? params.startAt : params.now

    try {
      const rows = await trx
        .select()
        .from(grants)
        .where(
          and(
            eq(grants.projectId, params.projectId),
            inArray(grants.customerEntitlementId, params.customerEntitlementIds),
            maxEffectiveAt === undefined ? undefined : lte(grants.effectiveAt, maxEffectiveAt),
            minExpiresAt === undefined
              ? undefined
              : or(isNull(grants.expiresAt), gt(grants.expiresAt, minExpiresAt))
          )
        )
        .orderBy(
          grants.customerEntitlementId,
          desc(grants.priority),
          asc(grants.expiresAt),
          asc(grants.id)
        )

      return Ok(rows)
    } catch (error) {
      this.logger.error(error, {
        context: "Error listing grants for entitlements",
        customerEntitlementIds: params.customerEntitlementIds,
        projectId: params.projectId,
      })

      return Err(
        new FetchError({
          message: `Failed to list grants: ${error instanceof Error ? error.message : String(error)}`,
          retry: true,
        })
      )
    }
  }

  public async listGrantsForCustomerFeature(params: {
    projectId: string
    customerId: string
    featureSlug: string
    now?: number
    startAt?: number
    endAt?: number
    db?: Database
  }): Promise<Result<GrantExtended[], FetchError>> {
    const trx = params.db ?? this.db
    const maxEffectiveAt = params.startAt !== undefined ? params.endAt : params.now
    const minExpiresAt = params.startAt !== undefined ? params.startAt : params.now

    try {
      const rows = (await trx.query.customerEntitlements.findMany({
        with: {
          featurePlanVersion: {
            with: {
              feature: true,
            },
          },
          grants: {
            where: (grant, { and: andOp, gt, isNull, lte, or }) =>
              andOp(
                maxEffectiveAt === undefined ? undefined : lte(grant.effectiveAt, maxEffectiveAt),
                minExpiresAt === undefined
                  ? undefined
                  : or(isNull(grant.expiresAt), gt(grant.expiresAt, minExpiresAt))
              ),
            orderBy: (grant, { asc, desc }) => [
              desc(grant.priority),
              asc(grant.expiresAt),
              asc(grant.id),
            ],
          },
        },
        where: (entitlement, { and: andOp, eq: eqOp, gt, isNull, lte, or }) =>
          andOp(
            eqOp(entitlement.projectId, params.projectId),
            eqOp(entitlement.customerId, params.customerId),
            maxEffectiveAt === undefined ? undefined : lte(entitlement.effectiveAt, maxEffectiveAt),
            minExpiresAt === undefined
              ? undefined
              : or(isNull(entitlement.expiresAt), gt(entitlement.expiresAt, minExpiresAt))
          ),
      })) as CustomerEntitlementExtended[]

      const featureEntitlements = rows.filter(
        (entitlement) => entitlement.featurePlanVersion.feature.slug === params.featureSlug
      )

      return Ok(
        featureEntitlements.flatMap(({ grants: entitlementGrants, ...customerEntitlement }) =>
          (entitlementGrants ?? []).map((grant) => ({
            ...grant,
            customerEntitlement,
          }))
        )
      )
    } catch (error) {
      this.logger.error(error, {
        context: "Error listing grants for customer feature",
        customerId: params.customerId,
        featureSlug: params.featureSlug,
        projectId: params.projectId,
      })

      return Err(
        new FetchError({
          message: `Failed to list grants: ${error instanceof Error ? error.message : String(error)}`,
          retry: true,
        })
      )
    }
  }

  public async expireGrant(params: {
    id: string
    projectId: string
    expiresAt: number
    db?: Database
  }): Promise<Result<Grant, FetchError | UnPriceGrantError>> {
    const trx = params.db ?? this.db

    try {
      const updated = await trx
        .update(grants)
        .set({
          expiresAt: params.expiresAt,
          updatedAtM: Date.now(),
        })
        .where(and(eq(grants.id, params.id), eq(grants.projectId, params.projectId)))
        .returning()
        .then((rows) => rows[0] ?? null)

      if (!updated) {
        return Err(
          new UnPriceGrantError({
            message: "Grant not found",
            subjectId: params.id,
          })
        )
      }

      return Ok(updated)
    } catch (error) {
      this.logger.error(error, {
        context: "Error expiring grant",
        grantId: params.id,
        projectId: params.projectId,
      })

      return Err(
        new FetchError({
          message: `Failed to expire grant: ${error instanceof Error ? error.message : String(error)}`,
          retry: true,
        })
      )
    }
  }

  public async expireGrantsForEntitlements(params: {
    customerEntitlementIds: string[]
    projectId: string
    expiresAt: number
    db?: Database
  }): Promise<Result<void, FetchError>> {
    const trx = params.db ?? this.db

    if (params.customerEntitlementIds.length === 0) {
      return Ok(undefined)
    }

    try {
      await trx
        .update(grants)
        .set({
          expiresAt: params.expiresAt,
          updatedAtM: Date.now(),
        })
        .where(
          and(
            eq(grants.projectId, params.projectId),
            inArray(grants.customerEntitlementId, params.customerEntitlementIds),
            or(isNull(grants.expiresAt), gt(grants.expiresAt, params.expiresAt))
          )
        )

      return Ok(undefined)
    } catch (error) {
      this.logger.error(error, {
        context: "Error expiring grants for entitlements",
        customerEntitlementIds: params.customerEntitlementIds,
        projectId: params.projectId,
      })

      return Err(
        new FetchError({
          message: `Failed to expire entitlement grants: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retry: true,
        })
      )
    }
  }
}
