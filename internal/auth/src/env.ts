import { createEnv } from "@t3-oss/env-core"
import { env as tinybirdEnv } from "@unprice/analytics/env"
import { env as dbEnv } from "@unprice/db/env"
import { z } from "zod"

export const env = createEnv({
  shared: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    APP_ENV: z.enum(["development", "preview", "production"]).default("development"),
  },
  server: {
    UNPRICE_API_KEY: z.string(),
    UNPRICE_API_URL: z.string().url().optional(),
    AUTH_GITHUB_CLIENT_ID: z.string().min(1),
    AUTH_GITHUB_CLIENT_SECRET: z.string().min(1),
    AUTH_GOOGLE_CLIENT_ID: z.string().min(1),
    AUTH_GOOGLE_CLIENT_SECRET: z.string().min(1),
    AUTH_REDIRECT_PROXY_URL: z.string().min(1),
    AUTH_SECRET:
      process.env.NODE_ENV === "production" ? z.string().min(32) : z.string().min(32).optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === "lint",
  extends: [dbEnv, tinybirdEnv],
  onValidationError: (issues) => {
    throw new Error(`Invalid environment variables in Auth: ${JSON.stringify(issues, null, 2)}`)
  },
})
