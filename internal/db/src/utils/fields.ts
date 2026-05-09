import { bigint, varchar } from "drizzle-orm/pg-core"

// Uses varchar(36) for proper type inference (dataType: 'string') with drizzle-orm and drizzle-zod,
// but patches getSQLType() so drizzle-kit migrations emit COLLATE "C" for sort performance.
export const cuid = (name: string) => {
  const builder = varchar(name, { length: 36 })
  // biome-ignore lint/suspicious/noExplicitAny: patching drizzle-orm internal build() to override getSQLType
  const origBuild = (builder as any).build
  // biome-ignore lint/suspicious/noExplicitAny: drizzle-orm internal API
  ;(builder as any).build = function (this: any, table: any) {
    const column = origBuild.call(this, table)
    column.getSQLType = () => 'varchar(36) COLLATE "C"'
    return column
  }
  return builder
}

// for workspace
export const id = {
  id: cuid("id").primaryKey().notNull(),
}

// for projects
export const workspaceID = {
  workspaceId: cuid("workspace_id").notNull(),
}

// common timestamps for all tables
// all dates are in UTC
export const timestamps = {
  createdAtM: bigint("created_at_m", { mode: "number" })
    .notNull()
    .default(0)
    .$defaultFn(() => Date.now()),
  updatedAtM: bigint("updated_at_m", { mode: "number" })
    .notNull()
    .default(0)
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now()),
}
