import { closeTestDatabaseConnection, migrateTestDatabase, truncateTestDatabase } from "./database"

function parseFixtureList(value: string | undefined) {
  return value
    ? value
        .split(",")
        .map((fixture) => fixture.trim())
        .filter(Boolean)
    : []
}

export default async function globalSetup() {
  const db = await migrateTestDatabase({
    fixtures: parseFixtureList(process.env.TEST_DB_FIXTURES),
  })

  return async () => {
    try {
      if (process.env.TEST_DB_TEARDOWN === "truncate") {
        await truncateTestDatabase(db)
      }
    } finally {
      await closeTestDatabaseConnection(db)
    }
  }
}
