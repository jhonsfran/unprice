import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { PlanService } from "./service"

describe("PlanService listPlanVersions enterprise filter", () => {
  it("returns only enterprise plans when enterprise=true, null when no plans", async () => {
    const db = {
      query: {
        versions: {
          findMany: vi.fn().mockResolvedValue([
            {
              plan: { enterprisePlan: true },
              planFeatures: [],
              currency: "USD",
              billingConfig: { billingInterval: "month" },
              projectId: "p",
              active: true,
              status: "published",
              latest: true,
            },
            {
              plan: { enterprisePlan: false },
              planFeatures: [],
              currency: "USD",
              billingConfig: { billingInterval: "month" },
              projectId: "p",
              active: true,
              status: "published",
              latest: true,
            },
          ]),
        },
      },
    } as unknown as Database

    const logger = {
      set: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      emit: vi.fn(),
      flush: vi.fn(),
    } as unknown as Logger
    const analytics = {} as unknown as Analytics
    const cache = {
      planVersionList: { swr: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()) },
    } as unknown as Cache
    const metrics = { emit: vi.fn(), flush: vi.fn(), setColo: vi.fn() } as unknown as Metrics

    const service = new PlanService({ db, logger, analytics, waitUntil: () => {}, cache, metrics })

    const { val, err } = await service.listPlanVersions({
      projectId: "p",
      query: {
        enterprise: true,
        latest: true,
        published: true,
        currency: "USD",
        billingInterval: "month",
      },
      opts: { skipCache: true },
    })

    expect(err).toBeUndefined()
    expect(val).not.toBeNull()
    expect(val!.length).toBe(1)
  })
})
