import { logger, schedules } from "@trigger.dev/sdk/v3"
import type { BudgetRun } from "@unprice/db/validators"
import { unprice } from "../../unprice"
import { db } from "../db"
import { createContext } from "../tasks/context"

/**
 * Backstop sweep for budget runs whose Postgres read-model row is stuck
 * `running` well past its expiry.
 *
 * The RunBudget DO is the source of truth: it closes expired runs in its own
 * SQLite storage (only the DO can release the run's wallet reservation) but no
 * longer writes the terminal row to Postgres. The dashboard refreshes rows on
 * observation via `BudgetRunService.listRunsRefreshed`; this sweep drives that
 * same observe-and-persist path for runs nobody has looked at recently, so the
 * read model (and its memory-first cache, invalidated inside updateRunSummary)
 * eventually converges even without a dashboard read.
 */

// A run still `running` this long past expiry is almost certainly finalized in
// its DO already. One hour matches the DO's own expiry cadence and keeps the
// sweep from racing freshly-expired runs that the DO alarm is still closing.
const STUCK_RUN_GRACE_MS = 60 * 60 * 1000

// Bounded fan-out per page. Keyset pagination drains every page in this
// invocation while keeping each query and refresh batch bounded.
const STUCK_RUN_PAGE_SIZE = 500

export const budgetRunsRefreshSchedule = schedules.task({
  id: "budget-runs.refresh",
  cron: {
    timezone: "UTC",
    // Hourly. This is only a convergence backstop — the dashboard already
    // refreshes on observation — so an hourly cadence is plenty.
    pattern: "0 * * * *",
  },
  run: async (payload) => {
    const now = payload.timestamp.getTime()
    const cutoff = new Date(now - STUCK_RUN_GRACE_MS)

    const projectIds = new Set<string>()
    let cursor: { expiresAt: Date; projectId: string; id: string } | undefined
    let page = 0
    let stuck = 0
    // "processed" = runs whose project-page refresh completed without a
    // project-level throw. listRunsRefreshed swallows per-run read failures and
    // only writes newly-terminal runs, so this is NOT a count of rows actually refreshed.
    let processed = 0

    while (true) {
      const stuckRuns = await db.query.budgetRuns.findMany({
        where: (run, { and, eq, gt, isNotNull, lt, or }) =>
          and(
            eq(run.status, "running"),
            isNotNull(run.expiresAt),
            lt(run.expiresAt, cutoff),
            cursor
              ? or(
                  gt(run.expiresAt, cursor.expiresAt),
                  and(
                    eq(run.expiresAt, cursor.expiresAt),
                    or(
                      gt(run.projectId, cursor.projectId),
                      and(eq(run.projectId, cursor.projectId), gt(run.id, cursor.id))
                    )
                  )
                )
              : undefined
          ),
        orderBy: (run, { asc }) => [asc(run.expiresAt), asc(run.projectId), asc(run.id)],
        limit: STUCK_RUN_PAGE_SIZE,
      })

      if (stuckRuns.length === 0) {
        break
      }

      page += 1
      stuck += stuckRuns.length
      logger.warn("budget-runs.refresh.stuck_runs", {
        count: stuckRuns.length,
        cutoff: cutoff.toISOString(),
        page,
      })

      // Advance from the fetched page regardless of refresh outcomes. Failed
      // rows remain running for the next hourly invocation, but cannot starve
      // later keys in this invocation.
      const lastRun = stuckRuns.at(-1)
      if (!lastRun?.expiresAt) {
        throw new Error("Stuck budget run page violated the non-null expiresAt predicate")
      }
      cursor = {
        expiresAt: lastRun.expiresAt,
        projectId: lastRun.projectId,
        id: lastRun.id,
      }

      // Group by project: listRunsRefreshed is scoped to one project, and each
      // project gets its own service context (logger/cache/analytics).
      const runsByProject = new Map<string, typeof stuckRuns>()
      for (const run of stuckRuns) {
        projectIds.add(run.projectId)
        const bucket = runsByProject.get(run.projectId)
        if (bucket) {
          bucket.push(run)
        } else {
          runsByProject.set(run.projectId, [run])
        }
      }

      for (const [projectId, runs] of runsByProject) {
        const context = await createContext({
          taskId: `budget-runs.refresh:${projectId}:${now}:${page}`,
          subscriptionId: "",
          projectId,
          defaultFields: {
            projectId,
            api: "jobs.budget-runs.refresh",
            now: now.toString(),
          },
        })

        let status = 200
        try {
          await context.services.budgetRuns.listRunsRefreshed({
            projectId,
            // Reconcile drizzle's inferred row type with the zod BudgetRun type
            // (json column nominal mismatch); same cast the service query methods use.
            runs: runs as unknown as BudgetRun[],
            runsGet: unprice.runs.get,
          })
          processed += runs.length
        } catch (error) {
          // One project's failure must not abort the sweep for the rest.
          status = 500
          logger.error("budget-runs.refresh.project_failed", {
            projectId,
            error: error instanceof Error ? error.message : String(error),
          })
        } finally {
          await context.flushLogs(status)
        }
      }

      if (stuckRuns.length < STUCK_RUN_PAGE_SIZE) {
        break
      }
    }

    const result = {
      projectIds: [...projectIds],
      stuck,
      processed,
    }
    logger.info("budget-runs.refresh.complete", result)
    return result
  },
})
