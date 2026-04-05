import { type StandardSchemaV1, createEnv } from "@t3-oss/env-core"
import { env as authEnv } from "@unprice/auth/env"
import { env as dbEnv } from "@unprice/db/env"
import { env as stripeEnv } from "@unprice/stripe/env"
import { env as trpcEnv } from "@unprice/trpc/env"
import { z } from "zod"

export const env = createEnv({
  shared: {
    VERCEL: z.enum(["1", "0"]).default("0"),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    APP_ENV: z.enum(["development", "preview", "production"]).default("development"),
  },
  server: {
    VERCEL_PROJECT_UNPRICE_ID: z.string(),
    VERCEL_TEAM_ID: z.string(),
    VERCEL_TOKEN: z.string(),
    ENCRYPTION_KEY: z.string(),
    AXIOM_API_TOKEN: z.string().optional(),
    AXIOM_DATASET: z.string().optional(),
    USERJOT_ID: z.string().optional().describe("The UserJot ID"),
    USERJOT_SECRET: z
      .string()
      .optional()
      .describe("The UserJot Secret Key for Identity Verification"),
  },
  runtimeEnv: process.env,
  clientPrefix: "NEXT_PUBLIC_",
  client: {},
  skipValidation:
    !!process.env.SKIP_ENV_VALIDATION ||
    process.env.npm_lifecycle_event === "lint" ||
    process.env.npm_lifecycle_event === "knip",
  extends: [authEnv, stripeEnv, trpcEnv, dbEnv],
  onValidationError: (issues: readonly StandardSchemaV1.Issue[]) => {
    console.error("❌ Invalid environment variables in NextJS:", issues)
    throw new Error("Invalid environment variables in NextJS")
  },
})
