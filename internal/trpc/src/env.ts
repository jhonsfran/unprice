import { createEnv } from "@t3-oss/env-core"
import { env as analyticsEnv } from "@unprice/analytics/env"
import { env as dbEnv } from "@unprice/db/env"
import { env as loggingEnv } from "@unprice/logging/env"
import { env as servicesEnv } from "@unprice/services/env"
import { env as vercelEnv } from "@unprice/vercel/env"

import * as z from "zod"

export const env = createEnv({
  shared: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    VERCEL_ENV: z.enum(["development", "preview", "production"]).default("development"),
    VERCEL_DEPLOYMENT_ID: z.string().optional(),
    VERCEL_REGION: z.string().optional(),
  },
  server: {
    UNPRICE_API_KEY: z.string(),
    UNPRICE_API_URL: z.string().url().optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === "lint",
  extends: [vercelEnv, dbEnv, loggingEnv, analyticsEnv, servicesEnv],
  onValidationError: (issues) => {
    throw new Error(`Invalid environment variables in TRPC: ${JSON.stringify(issues, null, 2)}`)
  },
})
