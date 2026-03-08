import { createEnv } from "@t3-oss/env-core"
import { env as analyticsEnv } from "@unprice/analytics/env"
import { env as dbEnv } from "@unprice/db/env"
import { env as observabilityEnv } from "@unprice/observability/env"
import { env as servicesEnv } from "@unprice/services/env"
import * as z from "zod"

export const env = createEnv({
  shared: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    APP_ENV: z.enum(["development", "preview", "production"]).default("development"),
  },
  server: {
    TRIGGER_SECRET_KEY: z.string(),
    ENCRYPTION_KEY: z.string(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === "lint",
  extends: [dbEnv, observabilityEnv, analyticsEnv, servicesEnv],
  onValidationError: (issues) => {
    throw new Error(`Invalid environment variables in Env: ${JSON.stringify(issues, null, 2)}`)
  },
})
