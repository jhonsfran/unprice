import { createEnv } from "@t3-oss/env-core"
import { z } from "zod"

export const env = createEnv({
  shared: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    APP_ENV: z.enum(["development", "preview", "production"]).default("development"),
  },
  server: {},
  client: {
    NEXT_PUBLIC_APP_DOMAIN: z.string().optional().default("localhost:3000"),
    NEXT_PUBLIC_APP_ENV: z.enum(["development", "preview", "production"]).optional(),
  },
  clientPrefix: "NEXT_PUBLIC_",
  runtimeEnv: {
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    NEXT_PUBLIC_APP_DOMAIN: process.env.NEXT_PUBLIC_APP_DOMAIN,
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === "lint",
  onValidationError: (issues) => {
    throw new Error(`Invalid environment variables in Env: ${JSON.stringify(issues, null, 2)}`)
  },
})
