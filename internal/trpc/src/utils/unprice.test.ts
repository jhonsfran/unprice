import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

describe("createProjectScopedUnpriceClient", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv("APP_ENV", "test")
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("SKIP_ENV_VALIDATION", "true")
    vi.stubEnv("UNPRICE_API_KEY", "unprice_dev_test")
    vi.stubEnv("UNPRICE_API_URL", "https://api.example.com")
    vi.stubEnv("UNPRICE_INTERNAL_API_SECRET", "internal_secret")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it("sends the active project id through internal replay headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ replayed: 1, skipped: 0 }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    )
    vi.stubGlobal("fetch", fetchMock)

    const { createProjectScopedUnpriceClient } = await import("./unprice")
    const client = createProjectScopedUnpriceClient("proj_dashboard")

    await client.replayFailedIngestionEvents({
      canonical_audit_ids: ["audit_1"],
    })

    const request = fetchMock.mock.calls[0]?.[0]
    expect(request).toBeInstanceOf(Request)
    expect((request as Request).headers.get("unprice-internal-secret")).toBe("internal_secret")
    expect((request as Request).headers.get("unprice-internal-project-id")).toBe("proj_dashboard")
    expect((request as Request).headers.get("authorization")).toBe("Bearer unprice_dev_test")
  })
})
