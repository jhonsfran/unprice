import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { Env } from "~/env"
import {
  DO_JURISDICTION,
  durableObjectJurisdiction,
  getBudgetStub,
  isJurisdictionSupported,
} from "./do-placement"

function createNamespaceHarness() {
  const getByName = vi.fn().mockReturnValue({ stub: true })
  const jurisdiction = vi.fn().mockReturnValue({ getByName })
  return { getByName, jurisdiction, namespace: { jurisdiction, getByName } }
}

describe("durable object placement", () => {
  it.each(["preview", "production"])(
    "places the budget automatically on %s, with the key as the name's tail",
    (appEnv) => {
      const harness = createNamespaceHarness()
      const env = {
        APP_ENV: appEnv,
        budget: harness.namespace,
      } as unknown as Pick<Env, "APP_ENV" | "budget">

      getBudgetStub(env, { projectId: "proj_123", key: "customer:acme/run:1" })

      // No jurisdiction and no hint: Cloudflare creates the object near its first request.
      expect(harness.jurisdiction).not.toHaveBeenCalled()
      expect(harness.getByName).toHaveBeenCalledWith(
        `${appEnv}:proj_123:budget:customer:acme/run:1`
      )
      expect(harness.getByName.mock.calls[0]).toHaveLength(1)
    }
  )

  it.each([
    ["preview", "eu"],
    ["production", "eu"],
    ["development", undefined],
  ])("resolves the broadcast jurisdiction on %s", (appEnv, jurisdiction) => {
    // workerd rejects jurisdictions, so local development addresses the
    // unscoped namespace. Everything else must be scoped.
    expect(durableObjectJurisdiction(appEnv)).toBe(jurisdiction)
  })

  it("scopes an unrecognised APP_ENV rather than silently skipping it", () => {
    // Fail loud in dev beats shipping unscoped objects to production.
    expect(isJurisdictionSupported("staging")).toBe(true)
    expect(durableObjectJurisdiction("staging")).toBe(DO_JURISDICTION)
    expect(durableObjectJurisdiction("development")).toBeUndefined()
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
    // site — including `const ns = env.budget; ns.getByName(...)`.
    // Tests are exempt: they address throwaway object names on purpose, and
    // the next guard still holds them to the scoped namespace.
    const addressing = /\.\s*(getByName|idFromName|newUniqueId)\s*\(/
    expect(offenders(addressing, { includeTests: false, allow: [PLACEMENT_MODULE] })).toEqual([])
  })

  it("never reaches through a raw money-state binding", () => {
    // `env.budget.<anything>` skips the canonical name builder. Wiring
    // (`budget: c.env.budget,`) has no trailing access and stays legal.
    // `budget` is also an ordinary field name, so the binding is matched only
    // when read off an env.
    const reachThrough = /\benv\s*\.\s*budget\s*\.\s*\w/
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
