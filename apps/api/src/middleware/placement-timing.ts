import type { MiddlewareHandler } from "hono"
import { setMetric } from "hono/timing"
import type { HonoEnv } from "~/hono/env"
import type { BudgetPlacement } from "~/ingestion/budget/BudgetDO"

/** Placement and cold-start markers on Server-Timing; production adds neither them nor their fetch. */
export function reportsPlacement(appEnv: string): boolean {
  return appEnv !== "production"
}

let isolateWarm = false

/** Marks where the Worker ran (`edge`) and whether this request was its isolate's first (`isolate`). */
export function placementTiming(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const cold = !isolateWarm
    isolateWarm = true
    if (reportsPlacement(c.env.APP_ENV)) {
      const colo = c.req.raw.cf?.colo
      if (typeof colo === "string" && colo) setMetric(c, "edge", colo)
      setMetric(c, "isolate", cold ? "cold" : "warm")
    }
    await next()
  }
}

/** The description of the `budget` entry: `do=EWR warm`, or nothing in production. */
export function budgetPlacementDescription(
  appEnv: string,
  placement: BudgetPlacement | undefined
): string | undefined {
  if (!placement || !reportsPlacement(appEnv)) return undefined
  return `do=${placement.colo} ${placement.cold ? "cold" : "warm"}`
}
