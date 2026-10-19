import type { Context, MiddlewareHandler } from "hono"
import { setMetric } from "hono/timing"
import type { HonoEnv } from "~/hono/env"
import type { BudgetTelemetry } from "~/ingestion/budget/BudgetDO"

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

/**
 * The `budget` entry is the Worker's round trip to the budget's object. Outside production its desc
 * says where the object ran and whether the request woke it (`do=EWR warm`; the benchmark harness
 * parses it).
 */
export function budgetTiming(
  c: Context<HonoEnv>,
  durationMs: number,
  telemetry: BudgetTelemetry | undefined
): void {
  const placed = reportsPlacement(c.env.APP_ENV) ? telemetry : undefined
  const description = placed?.colo
    ? `do=${placed.colo} ${placed.cold ? "cold" : "warm"}`
    : undefined
  setMetric(c, "budget", durationMs, description)
}
