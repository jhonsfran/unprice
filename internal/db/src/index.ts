import type { NeonQueryFunction, Pool } from "@neondatabase/serverless"
import type { NeonHttpDatabase } from "drizzle-orm/neon-http"
import type { NeonDatabase } from "drizzle-orm/neon-serverless"
import type { PgWithReplicas } from "drizzle-orm/pg-core"
import type * as schema from "./schema"

export * from "drizzle-orm"
export { pgTableProject as tableCreator } from "./utils"

type NeonDB = PgWithReplicas<
  NeonDatabase<typeof schema> & {
    $client: Pool
  }
>
type NeonTransactionDatabase = Parameters<Parameters<NeonDB["transaction"]>[0]>[0]

export type Database = NeonDB | NeonTransactionDatabase

/**
 * Drizzle client over the Neon HTTP driver. One HTTPS request per query, no interactive
 * transactions. See `createHttpConnection`.
 */
export type HttpDatabase = NeonHttpDatabase<typeof schema> & {
  $client: NeonQueryFunction<false, false>
}

export { createConnection, createHttpConnection } from "./createConnection"
