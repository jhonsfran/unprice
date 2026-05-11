import { sql } from "@unprice/db"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../test-fixtures/database"
import { seedTestDb } from "../test-fixtures/seed-db"
import { SubscriptionLock } from "./subscriptionLock"

const db = createTestDatabaseConnection()

const projectId = "proj_test"
const subscriptionId = "sub_lock_expiry_test"

describe("SubscriptionLock (real DB)", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures: ["base-project.sql"] })
  })

  it("allows takeover after expiry and releases only the current owner", async () => {
    const first = new SubscriptionLock({ db, projectId, subscriptionId })
    const second = new SubscriptionLock({ db, projectId, subscriptionId })
    const third = new SubscriptionLock({ db, projectId, subscriptionId })

    expect(await first.acquire({ now: 1_000, ttlMs: 100 })).toBe(true)
    expect(await second.acquire({ now: 1_050, ttlMs: 100 })).toBe(false)
    expect(await third.acquire({ now: 1_101, ttlMs: 100 })).toBe(true)

    await first.release()

    const lockRowsAfterStaleRelease = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM unprice_subscription_locks
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
    `)
    expect(lockRowsAfterStaleRelease.rows).toEqual([{ count: 1 }])

    await third.release()

    const lockRowsAfterCurrentRelease = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM unprice_subscription_locks
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
    `)
    expect(lockRowsAfterCurrentRelease.rows).toEqual([{ count: 0 }])
  })

  it("extends ownership in Postgres so an in-flight worker cannot be taken over", async () => {
    const first = new SubscriptionLock({ db, projectId, subscriptionId })
    const second = new SubscriptionLock({ db, projectId, subscriptionId })

    expect(await first.acquire({ now: 1_000, ttlMs: 100 })).toBe(true)
    expect(await first.extend({ now: 1_050, ttlMs: 100 })).toBe(true)
    expect(await second.acquire({ now: 1_101, ttlMs: 100 })).toBe(false)

    await first.release()
    expect(await second.acquire({ now: 1_102, ttlMs: 100 })).toBe(true)
  })
})
