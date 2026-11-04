import { createEnv } from "@t3-oss/env-core"
import { env as analyticsEnv } from "@unprice/analytics/env"
import { env as dbEnv } from "@unprice/db/env"
import { assertAllOrNoneConfigured } from "@unprice/lakehouse"
import { env as observabilityEnv } from "@unprice/observability/env"
import { env as servicesEnv } from "@unprice/services/env"
import { env as vercelEnv } from "@unprice/vercel/env"

import * as z from "zod"

export const env = createEnv({
  shared: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    APP_ENV: z.enum(["development", "preview", "production"]).default("development"),
    VERCEL_DEPLOYMENT_ID: z.string().optional(),
    VERCEL_REGION: z.string().optional(),
  },
  server: {
    UNPRICE_API_KEY: z.string(),
    UNPRICE_API_URL: z.string().url().optional(),
    // Basin SQL reads web analytics from R2 (an R2 API token with Basin SQL Read).
    BASIN_SQL_ACCOUNT_ID: z.string().optional(),
    BASIN_SQL_BUCKET: z.string().optional(),
    BASIN_SQL_TOKEN: z.string().optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === "lint",
  extends: [vercelEnv, dbEnv, observabilityEnv, analyticsEnv, servicesEnv],
  onValidationError: (issues) => {
    throw new Error(`Invalid environment variables in TRPC: ${JSON.stringify(issues, null, 2)}`)
  },
})

// Server variables cannot be read in the browser bundle, which imports this env through Next.js.
if (typeof window === "undefined") {
  assertAllOrNoneConfigured({
    BASIN_SQL_ACCOUNT_ID: env.BASIN_SQL_ACCOUNT_ID,
    BASIN_SQL_BUCKET: env.BASIN_SQL_BUCKET,
    BASIN_SQL_TOKEN: env.BASIN_SQL_TOKEN,
  })
}
