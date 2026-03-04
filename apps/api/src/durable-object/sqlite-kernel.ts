import { and, eq, lt, sql } from "drizzle-orm"
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite"
import { schema } from "~/db/types"

interface PutObjectParams {
  collection: string
  key: string
  payload: string
  updatedAt?: number
}

interface PutDedupeIdsParams {
  scope: string
  eventDate: string
  ids: Iterable<string>
  chunkSize?: number
  createdAt?: number
}

const DEFAULT_DEDUPE_CHUNK_SIZE = 500

export class SqliteDurableObjectKernel {
  constructor(private readonly db: DrizzleSqliteDODatabase<typeof schema>) {}

  async listObjects(collection: string): Promise<Array<{ key: string; payload: string }>> {
    return this.db
      .select({
        key: schema.stateObjects.key,
        payload: schema.stateObjects.payload,
      })
      .from(schema.stateObjects)
      .where(eq(schema.stateObjects.collection, collection))
  }

  async getObject(collection: string, key: string): Promise<string | null> {
    const rows = await this.db
      .select({ payload: schema.stateObjects.payload })
      .from(schema.stateObjects)
      .where(and(eq(schema.stateObjects.collection, collection), eq(schema.stateObjects.key, key)))
      .limit(1)

    return rows[0]?.payload ?? null
  }

  async putObject(params: PutObjectParams): Promise<void> {
    const updatedAt = params.updatedAt ?? Date.now()

    await this.db
      .insert(schema.stateObjects)
      .values({
        collection: params.collection,
        key: params.key,
        payload: params.payload,
        version: 1,
        updated_at: updatedAt,
      })
      .onConflictDoUpdate({
        target: [schema.stateObjects.collection, schema.stateObjects.key],
        set: {
          payload: params.payload,
          version: sql`${schema.stateObjects.version} + 1`,
          updated_at: updatedAt,
        },
      })
  }

  async deleteObject(collection: string, key: string): Promise<void> {
    await this.db
      .delete(schema.stateObjects)
      .where(and(eq(schema.stateObjects.collection, collection), eq(schema.stateObjects.key, key)))
  }

  async getDedupeSet(scope: string, eventDate: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ id: schema.dedupeKeys.id })
      .from(schema.dedupeKeys)
      .where(and(eq(schema.dedupeKeys.scope, scope), eq(schema.dedupeKeys.event_date, eventDate)))

    return new Set(rows.map((row) => row.id))
  }

  async putDedupeIds(params: PutDedupeIdsParams): Promise<void> {
    const dedupeIds = Array.from(params.ids)
    if (dedupeIds.length === 0) {
      return
    }

    const chunkSize = params.chunkSize ?? DEFAULT_DEDUPE_CHUNK_SIZE
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError(`Invalid dedupe chunk size: ${chunkSize}`)
    }

    const createdAt = params.createdAt ?? Date.now()

    for (let index = 0; index < dedupeIds.length; index += chunkSize) {
      const chunk = dedupeIds.slice(index, index + chunkSize)
      await this.db
        .insert(schema.dedupeKeys)
        .values(
          chunk.map((id) => ({
            scope: params.scope,
            event_date: params.eventDate,
            id,
            created_at: createdAt,
          }))
        )
        .onConflictDoNothing()
    }
  }

  async rotateDedupe(scope: string, cutoffDate: string): Promise<void> {
    await this.db
      .delete(schema.dedupeKeys)
      .where(and(eq(schema.dedupeKeys.scope, scope), lt(schema.dedupeKeys.event_date, cutoffDate)))
  }
}
