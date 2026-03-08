import { createEnv } from "@t3-oss/env-core"
import * as z from "zod"

export function shouldEmitMetrics(env: { APP_ENV?: string }): boolean {
  return env.APP_ENV === "production"
}

export function shouldDrainLogs(env: { APP_ENV?: string }): boolean {
  return env.APP_ENV !== "development"
}

export const env = createEnv({
  shared: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    APP_ENV: z.enum(["development", "preview", "production"]).default("development"),
  },
  server: {
    AXIOM_API_TOKEN: z.string().optional(),
    AXIOM_DATASET: z.string().optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === "lint",
  onValidationError: (issues) => {
    throw new Error(
      `Invalid environment variables in Observability: ${JSON.stringify(issues, null, 2)}`
    )
  },
})
