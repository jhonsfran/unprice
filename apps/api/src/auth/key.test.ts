import type { ApiKeyExtended } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { UnpriceApiError } from "~/errors"
import {
  isValidApiKeyShape,
  shouldBypassApiKeyRateLimit,
  validateIsAllowedToAccessProject,
} from "./key"

const asApiKey = (value: unknown) => value as ApiKeyExtended

const makeKey = (opts: { projectIsMain?: boolean | null; workspaceIsMain?: boolean }) =>
  asApiKey({
    projectId: "proj_key",
    project: {
      id: "proj_key",
      isMain: opts.projectIsMain ?? false,
      workspace: {
        isMain: opts.workspaceIsMain ?? false,
      },
    },
  })

const baseKey = makeKey({})

describe("validateIsAllowedToAccessProject", () => {
  it("uses key project when request does not provide a project", () => {
    const projectId = validateIsAllowedToAccessProject({
      key: baseKey,
      requestedProjectId: "",
    })

    expect(projectId).toBe("proj_key")
  })

  it("allows non-main keys to use their own project id", () => {
    const projectId = validateIsAllowedToAccessProject({
      key: baseKey,
      requestedProjectId: "proj_key",
    })

    expect(projectId).toBe("proj_key")
  })

  it("throws when non-main key requests another project", () => {
    expect(() =>
      validateIsAllowedToAccessProject({
        key: baseKey,
        requestedProjectId: "proj_other",
      })
    ).toThrowError(UnpriceApiError)
  })

  // Table-driven coverage of the canonical predicate: a key is "main" when either
  // the project OR its workspace is flagged main. This mirrors the eight routes that
  // now delegate the computation to the helper instead of passing their own boolean.
  const cases = [
    { name: "project.isMain", projectIsMain: true, workspaceIsMain: false, isMain: true },
    { name: "workspace.isMain", projectIsMain: false, workspaceIsMain: true, isMain: true },
    { name: "both main", projectIsMain: true, workspaceIsMain: true, isMain: true },
    { name: "neither main", projectIsMain: false, workspaceIsMain: false, isMain: false },
    { name: "null project.isMain", projectIsMain: null, workspaceIsMain: false, isMain: false },
  ] as const

  for (const testCase of cases) {
    it(`${testCase.name}: ${testCase.isMain ? "grants" : "denies"} cross-project access`, () => {
      const key = makeKey({
        projectIsMain: testCase.projectIsMain,
        workspaceIsMain: testCase.workspaceIsMain,
      })

      if (testCase.isMain) {
        expect(validateIsAllowedToAccessProject({ key, requestedProjectId: "proj_other" })).toBe(
          "proj_other"
        )
      } else {
        expect(() =>
          validateIsAllowedToAccessProject({ key, requestedProjectId: "proj_other" })
        ).toThrowError(UnpriceApiError)
      }
    })
  }
})

describe("isValidApiKeyShape", () => {
  it("accepts generated live key shape", () => {
    expect(isValidApiKeyShape("unprice_live_123456789ABCDEFGHJKLMN")).toBe(true)
  })

  it("accepts local dev keys only when explicitly allowed", () => {
    expect(isValidApiKeyShape("unprice_dev_1234567890")).toBe(false)
    expect(isValidApiKeyShape("unprice_dev_1234567890", { allowDevKey: true })).toBe(true)
  })

  it("rejects malformed and non-base58 keys", () => {
    expect(isValidApiKeyShape("sk_test_123")).toBe(false)
    expect(isValidApiKeyShape("unprice_live_123")).toBe(false)
    expect(isValidApiKeyShape("unprice_live_123456789ABCDEFGH0OIlM")).toBe(false)
  })
})

describe("shouldBypassApiKeyRateLimit", () => {
  it("bypasses rate limits for access check, including a trailing slash", () => {
    expect(shouldBypassApiKeyRateLimit("/v1/access/check")).toBe(true)
    expect(shouldBypassApiKeyRateLimit("/v1/access/check/")).toBe(true)
  })

  it("does not keep the old entitlement verify route as the bypass path", () => {
    expect(shouldBypassApiKeyRateLimit("/v1/entitlements/verify")).toBe(false)
  })
})
