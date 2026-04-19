import type { StorageAdapter } from "@unprice/services/entitlements"
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite"
import { meterWindowTable, type schema } from "./db/schema"

// DO-local adapter: one row per DO (the single meter). The engine uses
// opaque keyed storage via these methods, but the keys it writes always
// have one of two prefixes — "meter-state:" (current value) or
// "meter-state-updated-at:" (timestamp) — so we route them onto the
// dedicated columns of the singleton meter_window row.
const USAGE_PREFIX = "meter-state:"
const UPDATED_AT_PREFIX = "meter-state-updated-at:"

type Column = "usage" | "updatedAt"

function columnFor(key: string): Column {
  if (key.startsWith(UPDATED_AT_PREFIX)) return "updatedAt"
  if (key.startsWith(USAGE_PREFIX)) return "usage"
  throw new Error(`DrizzleStorageAdapter: unsupported key "${key}"`)
}

export class DrizzleStorageAdapter implements StorageAdapter {
  constructor(private db: DrizzleSqliteDODatabase<typeof schema>) {}

  async get<T>(key: string): Promise<T | null> {
    return this.getSync<T>(key)
  }

  getSync<T>(key: string): T | null {
    const column = columnFor(key)
    const row = this.db
      .select({ usage: meterWindowTable.usage, updatedAt: meterWindowTable.updatedAt })
      .from(meterWindowTable)
      .get()
    if (!row) return null
    const value = row[column]
    return (value as T | null | undefined) ?? null
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.putSync(key, value)
  }

  putSync<T>(key: string, value: T): void {
    const column = columnFor(key)
    const numeric = Number(value)
    // ensureMeterWindow inserts the singleton row before the engine runs,
    // so this UPDATE always hits exactly one row.
    this.db
      .update(meterWindowTable)
      .set({ [column]: numeric })
      .run()
  }

  async list<T>(prefix: string): Promise<T[]> {
    return this.listSync(prefix)
  }

  listSync<T>(prefix: string): T[] {
    const value = this.getSync<T>(prefix)
    return value === null ? [] : [value]
  }
}
