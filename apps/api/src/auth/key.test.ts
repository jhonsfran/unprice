import type { ApiKeyExtended } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { UnpriceApiError } from "~/errors"
import {
  isValidApiKeyShape,
  shouldBypassApiKeyRateLimit,
  validateIsAllowedToAccessProject,
} from "./key"

const baseKey = {
  projectId: "proj_key",
  project: {
    id: "proj_key",
    isMain: false,
  },
} as const

const asApiKey = (value: unknown) => value as ApiKeyExtended

describe("validateIsAllowedToAccessProject", () => {
  it("uses key project when request does not provide a project", () => {
    const projectId = validateIsAllowedToAccessProject({
      isMain: false,
      key: asApiKey(baseKey),
      requestedProjectId: "",
    })

    expect(projectId).toBe("proj_key")
  })

  it("allows non-main keys to use their own project id", () => {
    const projectId = validateIsAllowedToAccessProject({
      isMain: false,
      key: asApiKey(baseKey),
      requestedProjectId: "proj_key",
    })

    expect(projectId).toBe("proj_key")
  })

  it("throws when non-main key requests another project", () => {
    expect(() =>
      validateIsAllowedToAccessProject({
        isMain: false,
        key: asApiKey(baseKey),
        requestedProjectId: "proj_other",
      })
    ).toThrowError(UnpriceApiError)
  })

  it("allows main keys to access requested projects", () => {
    const projectId = validateIsAllowedToAccessProject({
      isMain: true,
      key: {
        ...baseKey,
        project: {
          ...baseKey.project,
          isMain: true,
        },
      } as ApiKeyExtended,
      requestedProjectId: "proj_other",
    })

    expect(projectId).toBe("proj_other")
  })
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
