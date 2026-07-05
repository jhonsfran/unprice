import type { Analytics } from "@unprice/analytics"
import { type Database, sql } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectFeatureCache } from "../cache"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../test-fixtures/database"
import { seedTestDb } from "../test-fixtures/seed-db"
import { ProjectService } from "./service"

const db = createTestDatabaseConnection()

function createLogger(): Logger {
  return {
    set: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    emit: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createProjectService(db: Database) {
  const cache = {
    projectFeatures: {
      swr: vi.fn((_key: string, fn: () => Promise<ProjectFeatureCache | null>) => fn()),
    },
  } as unknown as Cache

  return new ProjectService({
    db,
    logger: createLogger(),
    analytics: {} as unknown as Analytics,
    waitUntil: () => {},
    cache,
    metrics: { emit: vi.fn(), flush: vi.fn(), setColo: vi.fn() } as unknown as Metrics,
  })
}

type ProjectCascadeCounts = {
  projects: number
  customers: number
  apiKeys: number
  providerConfigs: number
  events: number
  features: number
}

describe("ProjectService deleteProjectRecord", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures: ["base-project.sql"] })
  })

  it("deletes a project and project-owned records through database cascades", async () => {
    const { val, err } = await createProjectService(db).deleteProjectRecord({
      projectId: "proj_test",
    })

    expect(err).toBeUndefined()
    expect(val?.state).toBe("ok")

    const counts = await db.execute<ProjectCascadeCounts>(sql`
      SELECT
        (SELECT COUNT(*)::int FROM unprice_projects WHERE id = 'proj_test') AS projects,
        (SELECT COUNT(*)::int FROM unprice_customers WHERE project_id = 'proj_test') AS customers,
        (SELECT COUNT(*)::int FROM unprice_apikeys WHERE project_id = 'proj_test') AS "apiKeys",
        (
          SELECT COUNT(*)::int
          FROM unprice_payment_provider_config
          WHERE project_id = 'proj_test'
        ) AS "providerConfigs",
        (SELECT COUNT(*)::int FROM unprice_events WHERE project_id = 'proj_test') AS events,
        (SELECT COUNT(*)::int FROM unprice_features WHERE project_id = 'proj_test') AS features
    `)

    expect(counts.rows[0]).toEqual({
      projects: 0,
      customers: 0,
      apiKeys: 0,
      providerConfigs: 0,
      events: 0,
      features: 0,
    })
  })
})
