import { eq } from "@unprice/db"
import { billingPeriods, subscriptionItems, subscriptionPhases } from "@unprice/db/schema"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../test-fixtures/database"
import { seedTestDb } from "../test-fixtures/seed-db"
import { DrizzleBillingRepository } from "./repository.drizzle"

const db = createTestDatabaseConnection()
const phaseId = "phase_test_monthly_advance"
const jan1 = 1767225600000
const feb1 = 1769904000000
const shortenedEnd = 1768435200000

async function periodDates(id: string) {
  return db
    .select({ cycleEndAt: billingPeriods.cycleEndAt, invoiceAt: billingPeriods.invoiceAt })
    .from(billingPeriods)
    .where(eq(billingPeriods.id, id))
}

describe("billing period cap boundaries in PostgreSQL", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({
      db,
      fixtures: [
        "base-project.sql",
        "plan-monthly-advance.sql",
        "customer-active.sql",
        "subscription-monthly-advance-active.sql",
      ],
    })
  })

  it("leaves invoiced periods unchanged when the phase ends early", async () => {
    await db
      .update(billingPeriods)
      .set({ status: "invoiced" })
      .where(eq(billingPeriods.id, "bp_test_advance_access_jan"))

    await new DrizzleBillingRepository(db).capPendingPeriodsAtPhaseEnd({
      phaseId,
      phaseEndAt: shortenedEnd,
    })

    expect(await periodDates("bp_test_advance_access_jan")).toEqual([
      { cycleEndAt: feb1, invoiceAt: jan1 },
    ])
    expect(await periodDates("bp_test_advance_events_jan")).toEqual([
      { cycleEndAt: shortenedEnd, invoiceAt: shortenedEnd },
    ])
  })

  it("leaves another phase's periods unchanged when the target phase ends early", async () => {
    const phase = await db.query.subscriptionPhases.findFirst({
      where: (table, { eq }) => eq(table.id, phaseId),
    })
    const item = await db.query.subscriptionItems.findFirst({
      where: (table, { eq }) => eq(table.id, "item_test_advance_events"),
    })
    const period = await db.query.billingPeriods.findFirst({
      where: (table, { eq }) => eq(table.id, "bp_test_advance_events_jan"),
    })
    if (!phase || !item || !period) throw new Error("Missing seeded phase, item, or period")
    await db.insert(subscriptionPhases).values({ ...phase, id: "phase_other" })
    await db.insert(subscriptionItems).values({
      ...item,
      id: "item_other",
      subscriptionPhaseId: "phase_other",
    })
    await db.insert(billingPeriods).values({
      ...period,
      id: "bp_other",
      subscriptionPhaseId: "phase_other",
      subscriptionItemId: "item_other",
    })

    await new DrizzleBillingRepository(db).capPendingPeriodsAtPhaseEnd({
      phaseId,
      phaseEndAt: shortenedEnd,
    })

    expect(await periodDates("bp_other")).toEqual([{ cycleEndAt: feb1, invoiceAt: feb1 }])
    expect(await periodDates("bp_test_advance_access_jan")).toEqual([
      { cycleEndAt: shortenedEnd, invoiceAt: jan1 },
    ])
    expect(await periodDates("bp_test_advance_events_jan")).toEqual([
      { cycleEndAt: shortenedEnd, invoiceAt: shortenedEnd },
    ])
  })
})
