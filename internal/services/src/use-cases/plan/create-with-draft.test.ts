import type { Database } from "@unprice/db"
import { Err, FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { createPlanWithDraft } from "./create-with-draft"

const PROJECT = "proj_1"

function createHarness(options: { existingDefault?: boolean } = {}) {
  const inserted: Record<string, unknown>[] = []
  const db = {
    query: {
      plans: {
        findFirst: vi.fn(async () => (options.existingDefault ? { id: "plan_old" } : undefined)),
      },
    },
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(values)
          return [values]
        },
      }),
    })),
  } as unknown as Database
  const createPlanVersionRecord = vi.fn(
    async (
      input: Record<string, unknown>
    ): Promise<
      | ReturnType<typeof Ok<{ state: "ok"; planVersion: Record<string, unknown> }>>
      | ReturnType<typeof Err<FetchError>>
    > => Ok({ state: "ok" as const, planVersion: { id: "pv_1", ...input } })
  )
  const services = {
    plans: { createPlanVersionRecord },
  } as unknown as Pick<ServiceContext, "plans">
  const logger = { set: vi.fn() } as unknown as Logger
  return { db, services, logger, inserted, createPlanVersionRecord }
}

describe("createPlanWithDraft", () => {
  it("creates the plan and a monthly draft in the project's currency with the trial given", async () => {
    const { db, services, logger, inserted, createPlanVersionRecord } = createHarness()

    const result = await createPlanWithDraft(
      { db, services, logger },
      {
        projectId: PROJECT,
        currency: "EUR",
        trialUnits: 14,
        input: { slug: "pro_ai", title: "Pro AI", description: "Agents by model." },
      }
    )

    expect(result.err).toBeUndefined()
    expect(inserted[0]).toMatchObject({ slug: "pro_ai", title: "Pro AI", projectId: PROJECT })
    expect(createPlanVersionRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: inserted[0]?.id,
        currency: "EUR",
        trialUnits: 14,
        whenToBill: "pay_in_arrear",
        collectionMethod: "charge_automatically",
        paymentProvider: "sandbox",
        billingConfig: expect.objectContaining({ billingInterval: "month" }),
      })
    )
    expect(result.val?.planVersion).toMatchObject({ id: "pv_1", title: "Pro AI" })
  })

  it("refuses a second default plan before writing anything", async () => {
    const { db, services, logger, inserted, createPlanVersionRecord } = createHarness({
      existingDefault: true,
    })

    const result = await createPlanWithDraft(
      { db, services, logger },
      {
        projectId: PROJECT,
        currency: "USD",
        input: { slug: "free", title: "Free", defaultPlan: true },
      }
    )

    expect(result.err?.message).toContain("already a default plan")
    expect(inserted).toEqual([])
    expect(createPlanVersionRecord).not.toHaveBeenCalled()
  })

  it("surfaces a version write failure after the plan exists", async () => {
    const { db, services, logger, createPlanVersionRecord } = createHarness()
    createPlanVersionRecord.mockResolvedValueOnce(
      Err(new FetchError({ message: "db down", retry: false }))
    )

    const result = await createPlanWithDraft(
      { db, services, logger },
      { projectId: PROJECT, currency: "USD", input: { slug: "pro", title: "Pro" } }
    )

    expect(result.err?.message).toBe("db down")
  })
})
