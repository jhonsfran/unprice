import { afterEach, describe, expect, it, vi } from "vitest"

describe("preview app URL configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("uses the public preview environment when the server environment is inherited", async () => {
    vi.stubEnv("APP_ENV", "development")
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "preview")
    vi.stubEnv("NEXT_PUBLIC_APP_DOMAIN", "pr-198-unprice.vercel.app")
    vi.stubEnv("SKIP_ENV_VALIDATION", "true")
    vi.resetModules()

    const { APP_DOMAIN } = await import("@unprice/config")

    expect(APP_DOMAIN).toBe("https://app-pr-198-unprice.vercel.app/")
  })

  it("keeps localhost on the local app host even when preview is inherited", async () => {
    vi.stubEnv("APP_ENV", "development")
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "preview")
    vi.stubEnv("NEXT_PUBLIC_APP_DOMAIN", "localhost:3000")
    vi.stubEnv("SKIP_ENV_VALIDATION", "true")
    vi.resetModules()

    const { APP_BASE_DOMAIN, APP_DOMAIN, BASE_URL } = await import("@unprice/config")

    expect(APP_BASE_DOMAIN).toBe("app.localhost:3000")
    expect(APP_DOMAIN).toBe("http://app.localhost:3000/")
    expect(BASE_URL).toBe("http://localhost:3000")
  })
})
