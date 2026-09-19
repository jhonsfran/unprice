import { buildIngestionWindowName, buildRunBudgetName } from "@unprice/services/ingestion"
import type { Env } from "~/env"

/**
 * The only place a Durable Object is addressed.
 *
 * Every DO in this app holds customer money state — entitlement windows carry
 * wallet reservations, run budgets carry allocations and idempotency keys — so
 * all of it is pinned to the EU jurisdiction. `jurisdiction()` is a guarantee
 * (Cloudflare will not place or migrate the object outside the EU), unlike
 * `locationHint`, which is only honoured at creation. The hint is kept on top
 * of it to bias placement toward Western Europe *within* the jurisdiction.
 *
 * Everything goes through this module on purpose. Jurisdiction is part of a
 * DO's identity: `ns.idFromName(x)` and `ns.jurisdiction("eu").idFromName(x)`
 * are different objects with different storage. Two failure modes follow, and
 * both are silent:
 *
 *   1. Mixing namespaces. Deriving an ID from the base namespace and calling
 *      `get()` on the jurisdictional one (or the reverse) throws at runtime,
 *      not at compile time. `getByName` on a single scoped namespace makes the
 *      mistake unrepresentable, so the helpers below never expose an ID.
 *   2. Split-brain addressing. The entitlement window is reached from two call
 *      paths (the ingestion client and the run-budget pricing delegate). If one
 *      scopes and the other does not, an entitlement ends up with two DOs: one
 *      holding the wallet reservations, one applying the meter. Both paths call
 *      `getEntitlementWindowStub` for exactly this reason.
 *
 * `do-placement.test.ts` fails the build if either invariant is reintroduced.
 *
 * CUTOVER NOTE (2026-09-19): moving to the EU jurisdiction changed every
 * object ID. Nothing outside the DOs references those IDs — `idFromString` is
 * unused and `ctx.id.toString()` only feeds log correlation — so there are no
 * dangling references. What was left behind is the SQLite storage of the
 * pre-cutover objects: open reservations, run allocations, and idempotency
 * keys. Those objects still exist and their alarms still fire, so they can keep
 * emitting billing facts for state the EU objects know nothing about. Deleting
 * them is an ops step (Cloudflare API, per namespace), not something this
 * module can do.
 */
export const DO_JURISDICTION = "eu" as const satisfies DurableObjectJurisdiction

/**
 * Jurisdictions exist only on the real edge. workerd — which backs both
 * `wrangler dev` and the vitest-pool-workers suite — throws
 * "Jurisdiction restrictions are not implemented in workerd." the moment
 * `jurisdiction()` is called, so local runs address the unscoped namespace.
 *
 * Written as an opt-out rather than an opt-in on purpose: an APP_ENV nobody
 * anticipated still gets the jurisdiction. That fails loudly in local dev,
 * which is recoverable, instead of silently shipping unscoped objects to
 * production, which is not.
 */
const LOCAL_APP_ENV = "development" satisfies Env["APP_ENV"]

export function isJurisdictionSupported(appEnv: string): boolean {
  return appEnv !== LOCAL_APP_ENV
}

/**
 * The jurisdiction for callers that take it as an option instead of calling
 * `jurisdiction()` themselves — partyserver, which owns DurableObjectProject's
 * routing. `undefined` locally, for the reason above.
 */
export function durableObjectJurisdiction(appEnv: string): DurableObjectJurisdiction | undefined {
  return isJurisdictionSupported(appEnv) ? DO_JURISDICTION : undefined
}

/**
 * Placement bias inside the jurisdiction. Honoured at object creation only;
 * an object that already exists is never relocated.
 */
export const DO_LOCATION_HINT = { locationHint: "weur" } as const satisfies {
  locationHint: DurableObjectLocationHint
}

/** EU-scoped entitlement-window namespace. Never use the raw binding. */
export function entitlementWindowNamespace(
  env: Pick<Env, "APP_ENV" | "entitlementwindow">
): Env["entitlementwindow"] {
  return isJurisdictionSupported(env.APP_ENV)
    ? env.entitlementwindow.jurisdiction(DO_JURISDICTION)
    : env.entitlementwindow
}

/** EU-scoped run-budget namespace. Never use the raw binding. */
export function runBudgetNamespace(env: Pick<Env, "APP_ENV" | "runbudget">): Env["runbudget"] {
  return isJurisdictionSupported(env.APP_ENV)
    ? env.runbudget.jurisdiction(DO_JURISDICTION)
    : env.runbudget
}

export type EntitlementWindowStub = ReturnType<Env["entitlementwindow"]["getByName"]>
export type RunBudgetStub = ReturnType<Env["runbudget"]["getByName"]>

/**
 * The canonical entitlement-window address: EU jurisdiction, Western Europe
 * hint, and the shared name builder. Both the ingestion client and the
 * run-budget pricing delegate must resolve to the same object, so neither
 * builds the name itself.
 */
export function getEntitlementWindowStub(
  env: Pick<Env, "APP_ENV" | "entitlementwindow">,
  params: { customerEntitlementId: string; customerId: string; projectId: string }
): EntitlementWindowStub {
  return entitlementWindowNamespace(env).getByName(
    buildIngestionWindowName({
      appEnv: env.APP_ENV,
      customerEntitlementId: params.customerEntitlementId,
      customerId: params.customerId,
      projectId: params.projectId,
    }),
    DO_LOCATION_HINT
  )
}

/** The canonical run-budget address. Same rules as above. */
export function getRunBudgetStub(
  env: Pick<Env, "APP_ENV" | "runbudget">,
  params: { customerId: string; projectId: string; runId: string }
): RunBudgetStub {
  return runBudgetNamespace(env).getByName(
    buildRunBudgetName({
      appEnv: env.APP_ENV,
      customerId: params.customerId,
      projectId: params.projectId,
      runId: params.runId,
    }),
    DO_LOCATION_HINT
  )
}
