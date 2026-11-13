import type { Env } from "~/env"

/**
 * The only place a Durable Object is addressed.
 *
 * Jurisdiction is part of a DO's identity: `ns.idFromName(x)` and
 * `ns.jurisdiction("eu").idFromName(x)` are different objects with different
 * storage. Deriving an ID from one namespace and calling `get()` on the other
 * throws at runtime, not at compile time, so the helpers below never expose an
 * ID, and every caller resolves a stub here. `do-placement.test.ts` fails the
 * build if an object is addressed anywhere else.
 *
 * DurableObjectProject (partyserver broadcast state) is pinned to the EU
 * jurisdiction through `durableObjectJurisdiction`.
 *
 * BUDGETS USE AUTOMATIC PLACEMENT (2026-10-18, ADR-0008 D9): a budget is
 * checked before every model call from wherever the customer's backend runs,
 * so it has no jurisdiction and no hint, and Cloudflare creates each object
 * near its first request and never moves it. Budget state is therefore not
 * guaranteed to stay in the EU; a per-project residency setting would bring
 * the jurisdiction back for projects that need it.
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

/** The key is the tail, so a key containing ":" or "/" cannot collide with another address. */
function buildBudgetName(params: {
  appEnv: string
  projectId: string
  key: string
}): string {
  return `${params.appEnv}:${params.projectId}:budget:${params.key}`
}

/**
 * The canonical budget address: automatic placement, so no jurisdiction and no location hint. Every
 * verb must resolve through here, or a key would end up with two objects.
 */
export function getBudgetStub(
  env: Pick<Env, "APP_ENV" | "budget">,
  params: { projectId: string; key: string }
) {
  return env.budget.getByName(
    buildBudgetName({ appEnv: env.APP_ENV, projectId: params.projectId, key: params.key })
  )
}
