import { describe, expect, it } from "vitest"
import type { ApiKeyExtended } from "@unprice/db/validators"
import { UnpriceApiError } from "~/errors"
import { validateIsAllowedToAccessProject } from "./key"

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
