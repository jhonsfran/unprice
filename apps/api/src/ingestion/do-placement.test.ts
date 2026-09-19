import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { Env } from "~/env"
import {
  DO_JURISDICTION,
  DO_LOCATION_HINT,
  durableObjectJurisdiction,
  getEntitlementWindowStub,
  getRunBudgetStub,
  isJurisdictionSupported,
} from "./do-placement"

function createNamespaceHarness() {
  const getByName = vi.fn().mockReturnValue({ stub: true })
  const jurisdiction = vi.fn().mockReturnValue({ getByName })
  return { getByName, jurisdiction, namespace: { jurisdiction, getByName } }
}

describe("durable object placement", () => {
  it("scopes the entitlement window to the EU jurisdiction with the canonical name", () => {
    const harness = createNamespaceHarness()
    const env = {
      APP_ENV: "preview",
      entitlementwindow: harness.namespace,
    } as unknown as Pick<Env, "APP_ENV" | "entitlementwindow">

    getEntitlementWindowStub(env, {
      customerEntitlementId: "ce_123",
      customerId: "cus_123",
      projectId: "proj_123",
    })

    expect(harness.jurisdiction).toHaveBeenCalledWith("eu")
    expect(harness.getByName).toHaveBeenCalledWith(
      "preview:proj_123:cus_123:ce_123",
      DO_LOCATION_HINT
    )
  })

  it("scopes the run budget to the EU jurisdiction with the canonical name", () => {
    const harness = createNamespaceHarness()
    const env = {
      APP_ENV: "preview",
      runbudget: harness.namespace,
    } as unknown as Pick<Env, "APP_ENV" | "runbudget">

    getRunBudgetStub(env, {
      customerId: "cus_123",
      projectId: "proj_123",
      runId: "brun_123",
    })

    expect(harness.jurisdiction).toHaveBeenCalledWith("eu")
    expect(harness.getByName).toHaveBeenCalledWith(
      "preview:proj_123:cus_123:brun_123",
      DO_LOCATION_HINT
    )
  })

  it.each([
    ["preview", true],
    ["production", true],
    ["development", false],
  ])("applies the jurisdiction on %s", (appEnv, scoped) => {
    const harness = createNamespaceHarness()
    const env = {
      APP_ENV: appEnv,
      runbudget: harness.namespace,
    } as unknown as Pick<Env, "APP_ENV" | "runbudget">

    getRunBudgetStub(env, { customerId: "c", projectId: "p", runId: "r" })

    // workerd rejects jurisdictions, so local development addresses the
    // unscoped namespace. Everything else must be scoped.
    expect(harness.jurisdiction).toHaveBeenCalledTimes(scoped ? 1 : 0)
    expect(harness.getByName).toHaveBeenCalledTimes(1)
  })

  it("scopes an unrecognised APP_ENV rather than silently skipping it", () => {
    // Fail loud in dev beats shipping unscoped objects to production.
    expect(isJurisdictionSupported("staging")).toBe(true)
    expect(durableObjectJurisdiction("staging")).toBe(DO_JURISDICTION)
    expect(durableObjectJurisdiction("development")).toBeUndefined()
  })

  it("never hands out a bare DurableObjectId", () => {
    // idFromName + get() on different namespaces throws at runtime, not at
    // compile time. The helpers return a stub so the pair cannot be split.
    const harness = createNamespaceHarness()
    const env = {
      APP_ENV: "preview",
      runbudget: harness.namespace,
    } as unknown as Pick<Env, "APP_ENV" | "runbudget">

    getRunBudgetStub(env, { customerId: "c", projectId: "p", runId: "r" })

    expect(harness.namespace).not.toHaveProperty("idFromName.mock")
    expect(harness.getByName).toHaveBeenCalledTimes(1)
  })
})

// Architecture guard. Jurisdiction is part of a Durable Object's identity, so a
// single unscoped call site silently creates a second object holding half the
// money state. These checks fail the build rather than leaving that to review.
//
// Passing a raw binding *into* a client constructor is fine and stays legal —
// that is dependency wiring, and the client scopes it. What is banned is
// addressing an object outside this module.

const SRC_ROOT = resolve(__dirname, "..")
const PLACEMENT_MODULE = "ingestion/do-placement.ts"

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith(".ts") ? [full] : []
  })
}

// Comments are stripped first so that documenting the banned pattern — which
// this module and its mock helper both do on purpose — does not fail the build.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

function offenders(pattern: RegExp, options: { includeTests: boolean; allow: string[] }): string[] {
  return sourceFiles(SRC_ROOT)
    .map((file) => relative(SRC_ROOT, file).replaceAll("\\", "/"))
    .filter((file) => !options.allow.includes(file))
    .filter((file) => options.includeTests || !file.includes(".test."))
    .filter((file) => pattern.test(stripComments(readFileSync(join(SRC_ROOT, file), "utf8"))))
}

describe("durable object placement guards", () => {
  it("addresses durable objects only through do-placement.ts", () => {
    // Catches the whole family, whatever the binding is called at the call
    // site — including `const ns = env.runbudget; ns.getByName(...)`.
    // Tests are exempt: they address throwaway object names on purpose, and
    // the next guard still holds them to the scoped namespace.
    const addressing = /\.\s*(getByName|idFromName|newUniqueId)\s*\(/
    expect(offenders(addressing, { includeTests: false, allow: [PLACEMENT_MODULE] })).toEqual([])
  })

  it("never reaches through a raw money-state binding", () => {
    // `env.entitlementwindow.<anything>` — the form that skips the
    // jurisdiction. Wiring (`entitlementwindow: c.env.entitlementwindow,`) has
    // no trailing access and stays legal.
    const reachThrough = /\.\s*(entitlementwindow|runbudget)\s*\.\s*\w/
    expect(offenders(reachThrough, { includeTests: true, allow: [PLACEMENT_MODULE] })).toEqual([])
  })

  it("declares the jurisdiction only once", () => {
    // Callers must import DO_JURISDICTION. A hardcoded "eu" elsewhere is how
    // the constant and the deployment drift apart.
    const literal = /jurisdiction\s*[:(]\s*["\'`]/
    expect(offenders(literal, { includeTests: true, allow: [PLACEMENT_MODULE] })).toEqual([])
  })

  it("keeps the exported jurisdiction on the EU value the deployment assumes", () => {
    expect(DO_JURISDICTION).toBe("eu")
  })
})
