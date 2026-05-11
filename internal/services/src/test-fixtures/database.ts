import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type Database, createConnection, sql } from "@unprice/db"
import { installPgledger, runDrizzleMigrations } from "@unprice/db/migrate"
import { seedTestDb } from "./seed-db"

const fixtureDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(fixtureDir, "../../../..")
const dbPackageRoot = resolve(repoRoot, "internal/db")
const defaultTestDatabaseUrl = "postgresql://postgres:postgres@localhost:5432/unprice_test"

export type MigrateTestDatabaseOptions = {
  databaseUrl?: string
  fixtures?: string[]
  seedDir?: string
}

type PgDatabaseRow = {
  exists: boolean
}

type PgTableRow = {
  tablename: string
}

function getDatabaseUrl(databaseUrl = process.env.DATABASE_URL ?? defaultTestDatabaseUrl) {
  return databaseUrl
}

function databaseNameFromUrl(databaseUrl: string) {
  const url = new URL(databaseUrl)
  const databaseName = url.pathname.replace(/^\//, "")

  if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) {
    throw new Error(`Unsafe test database name: ${databaseName}`)
  }

  return databaseName
}

function databaseUrlForName(databaseUrl: string, databaseName: string) {
  const url = new URL(databaseUrl)
  url.pathname = `/${databaseName}`
  return url.toString()
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`
}

export function createTestDatabaseConnection(databaseUrl = getDatabaseUrl()): Database {
  return createConnection({
    // Local Postgres is reached through the wsproxy in docker-compose.yaml.
    env: "development",
    primaryDatabaseUrl: databaseUrl,
    logger: false,
    singleton: false,
  })
}

type CloseableClient = {
  end: () => Promise<void> | void
}

type DatabaseWithConnectionInternals = {
  $client?: unknown
  $primary?: unknown
  $replicas?: unknown
}

function isCloseableClient(value: unknown): value is CloseableClient {
  return (
    typeof value === "object" &&
    value !== null &&
    "end" in value &&
    typeof (value as { end?: unknown }).end === "function"
  )
}

function collectClient(value: unknown, clients: Set<CloseableClient>) {
  if (typeof value !== "object" || value === null) return

  const candidate = value as DatabaseWithConnectionInternals
  if (isCloseableClient(candidate.$client)) {
    clients.add(candidate.$client)
  }
}

export async function closeTestDatabaseConnection(db: Database) {
  const clients = new Set<CloseableClient>()
  const internals = db as DatabaseWithConnectionInternals

  collectClient(db, clients)
  collectClient(internals.$primary, clients)

  if (Array.isArray(internals.$replicas)) {
    for (const replica of internals.$replicas) {
      collectClient(replica, clients)
    }
  }

  await Promise.all([...clients].map((client) => client.end()))
}

export async function ensureTestDatabase(databaseUrl = getDatabaseUrl()) {
  const databaseName = databaseNameFromUrl(databaseUrl)
  const adminUrl = databaseUrlForName(databaseUrl, "postgres")
  const adminDb = createTestDatabaseConnection(adminUrl)
  try {
    const exists = await adminDb.execute<PgDatabaseRow>(
      sql`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${databaseName}) AS "exists"`
    )

    if (!exists.rows[0]?.exists) {
      await adminDb.execute(sql.raw(`CREATE DATABASE ${quoteIdentifier(databaseName)}`))
    }
  } finally {
    await closeTestDatabaseConnection(adminDb)
  }
}

export async function migrateTestDatabase({
  databaseUrl = getDatabaseUrl(),
  fixtures = [],
  seedDir,
}: MigrateTestDatabaseOptions = {}) {
  await ensureTestDatabase(databaseUrl)

  const db = createTestDatabaseConnection(databaseUrl)
  await runDrizzleMigrations(db, {
    migrationsFolder: resolve(dbPackageRoot, "src/migrations"),
  })
  await installPgledger(db, {
    pgledgerDir: resolve(dbPackageRoot, "src/migrations/pgledger"),
  })

  if (fixtures.length > 0) {
    await seedTestDb({ db, fixtures, seedDir })
  }

  return db
}

export async function truncateTestDatabase(db: Database) {
  const tableRows = await db.execute<PgTableRow>(sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND (
        tablename LIKE 'unprice_%'
        OR tablename IN ('pgledger_accounts', 'pgledger_transfers', 'pgledger_entries')
      )
    ORDER BY tablename
  `)
  const tableNames = tableRows.rows.map((row) => row.tablename)

  if (tableNames.length === 0) {
    return
  }

  await db.execute(
    sql.raw(`TRUNCATE TABLE ${tableNames.map(quoteIdentifier).join(", ")} RESTART IDENTITY CASCADE`)
  )
}
