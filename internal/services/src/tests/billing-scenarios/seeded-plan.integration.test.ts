import { sql } from "@unprice/db"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { createTestDatabaseConnection, truncateTestDatabase } from "../../test-fixtures/database"
import { closeTestDatabaseConnection } from "../../test-fixtures/database"
import { seedTestDb } from "../../test-fixtures/seed-db"

const db = createTestDatabaseConnection()

const billingFixtures = [
  "base-project.sql",
  "plan-monthly-arrear.sql",
  "plan-monthly-advance.sql",
  "customer-active.sql",
]

type SeededPlanVersionRow = {
  id: string
  plan_slug: string
  when_to_bill: "pay_in_advance" | "pay_in_arrear"
  feature_count: number
}

describe("billing SQL seed fixtures", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures: billingFixtures })
  })

  it("restores invoice-backed monthly plan versions with features", async () => {
    const result = await db.execute<SeededPlanVersionRow>(sql`
      SELECT
        pv.id,
        p.slug AS plan_slug,
        pv.when_to_bill,
        COUNT(pvf.id)::int AS feature_count
      FROM unprice_plan_versions pv
      JOIN unprice_plans p
        ON p.id = pv.plan_id
        AND p.project_id = pv.project_id
      JOIN unprice_plan_versions_features pvf
        ON pvf.plan_version_id = pv.id
        AND pvf.project_id = pv.project_id
      WHERE pv.project_id = 'proj_test'
      GROUP BY pv.id, p.slug, pv.when_to_bill
      ORDER BY pv.when_to_bill
    `)

    expect(result.rows).toEqual([
      {
        feature_count: 2,
        id: "pv_test_monthly_advance",
        plan_slug: "pro",
        when_to_bill: "pay_in_advance",
      },
      {
        feature_count: 2,
        id: "pv_test_monthly_arrear",
        plan_slug: "pro",
        when_to_bill: "pay_in_arrear",
      },
    ])
  })

  it("restores the active billing customer", async () => {
    const result = await db.execute<{ id: string; active: boolean; default_currency: "EUR" }>(sql`
      SELECT id, active, default_currency
      FROM unprice_customers
      WHERE id = 'cus_test'
        AND project_id = 'proj_test'
    `)

    expect(result.rows).toEqual([
      {
        active: true,
        default_currency: "EUR",
        id: "cus_test",
      },
    ])
  })
})
