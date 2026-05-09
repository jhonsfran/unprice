import { createEnv } from "@t3-oss/env-core"
import * as z from "zod"

export const env = createEnv({
  shared: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    APP_ENV: z.enum(["development", "preview", "production"]).default("development"),
  },
  server: {
    STRIPE_API_KEY: z.string().optional(),
    STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === "lint",
  onValidationError: (issues) => {
    throw new Error(`Invalid environment variables in Stripe: ${JSON.stringify(issues, null, 2)}`)
  },
})
