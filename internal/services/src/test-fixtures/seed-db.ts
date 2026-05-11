import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Database, sql } from "@unprice/db"

const fixtureDir = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_SEED_DIR = join(fixtureDir, "seeds")

export type SeedFixtureInput = {
  db: Database
  fixtures: string[]
  seedDir?: string
}

function resolveFixturePath(seedDir: string, fixture: string) {
  if (isAbsolute(fixture)) return fixture
  return join(seedDir, fixture)
}

export async function seedTestDb({ db, fixtures, seedDir = DEFAULT_SEED_DIR }: SeedFixtureInput) {
  for (const fixture of fixtures) {
    const fixturePath = resolveFixturePath(seedDir, fixture)
    const fixtureSql = await readFile(fixturePath, "utf8")

    if (fixtureSql.trim().length === 0) {
      continue
    }

    await db.execute(sql.raw(fixtureSql))
  }
}
