import type { Pipeline } from "cloudflare:pipelines"
import { type StandardSchemaV1, createEnv } from "@t3-oss/env-core"
import { env as envAnalytics } from "@unprice/analytics/env"
import { env as envDb } from "@unprice/db/env"
import { env as envObservability } from "@unprice/observability/env"
import { env as envServices } from "@unprice/services/env"
import { z } from "zod"
import type { EntitlementWindowDO } from "~/ingestion/entitlements/EntitlementWindowDO"
import type { DurableObjectProject } from "./project/do"

export const cloudflareRatelimiter = z.custom<{
  limit: (opts: { key: string }) => Promise<{ success: boolean }>
}>((r) => !!r && typeof r.limit === "function")

function isCloudflarePipeline(value: unknown): value is Pipeline {
  if (!value || typeof value !== "object") {
    return false
  }

  return "send" in value && typeof value.send === "function"
}

export const cloudflarePipeline = z.custom<Pipeline>(isCloudflarePipeline)
export const cloudflareQueue = z.custom<Queue<unknown>>(
  (queue) =>
    !!queue && typeof queue === "object" && "send" in queue && typeof queue.send === "function"
)
export const cloudflareR2Bucket = z.custom<R2Bucket>(
  (bucket) =>
    !!bucket && typeof bucket === "object" && "put" in bucket && typeof bucket.put === "function"
)

function readOptionalStringBinding(workerEnv: Record<string, unknown>, key: string) {
  const value = workerEnv[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

// This function should be called at the start of each request.
export function createRuntimeEnv(workerEnv: Record<string, unknown>) {
  const parsedEnv = createEnv({
    shared: {
      NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
      APP_ENV: z.enum(["development", "preview", "production"]).default("development"),
    },
    server: {
      AUTH_SECRET: z.string(),
      VERSION: z.string().default("unknown"),
      projectdo: z.custom<DurableObjectNamespace<DurableObjectProject>>(
        (ns) => typeof ns === "object"
      ),
      entitlementwindow: z.custom<DurableObjectNamespace<EntitlementWindowDO>>(
        (ns) => typeof ns === "object"
      ),
      RL_FREE_1000_60s: cloudflareRatelimiter,
      RL_FREE_6000_60s: cloudflareRatelimiter,
      CLOUDFLARE_ZONE_ID: z.string().optional(),
      CLOUDFLARE_API_TOKEN: z.string().optional(),
      CLOUDFLARE_ACCOUNT_ID: z.string(),
      CLOUDFLARE_CACHE_DOMAIN: z.string().optional(),
      LOCAL_PIPELINE_URL: z.string().url().optional(),
      PIPELINE_EVENTS: cloudflarePipeline.optional(),
      QUEUE_SHARD_0: cloudflareQueue,
      QUEUE_SHARD_1: cloudflareQueue,
      INGESTION_REPORTING_QUEUE: cloudflareQueue,
      LAKEHOUSE: cloudflareR2Bucket,
      LAKEHOUSE_FILE_PLAN_BASE_URL: z.string().url(),
      LAKEHOUSE_API_TOKEN: z.string(),
      STRIPE_API_KEY: z.string().optional(),
      STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
    },
    emptyStringAsUndefined: true,
    runtimeEnv: workerEnv as Record<string, string | number | boolean | undefined>,
    extends: [envServices, envDb, envAnalytics, envObservability],
    skipValidation:
      !!process.env.SKIP_ENV_VALIDATION ||
      process.env.npm_lifecycle_event === "lint" ||
      process.env.npm_lifecycle_event === "knip",
    onValidationError: (issues: readonly StandardSchemaV1.Issue[]) => {
      throw new Error(`Invalid environment variables in API: ${JSON.stringify(issues, null, 2)}`)
    },
  })

  if (parsedEnv.APP_ENV !== "development" && !parsedEnv.PIPELINE_EVENTS) {
    throw new Error("PIPELINE_EVENTS binding is required outside development")
  }

  return {
    ...parsedEnv,
    // The services env is created from process.env and is also extended into
    // this Worker env. Prefer Worker bindings here so `.dev.vars` and
    // Cloudflare secrets are not overwritten by an undefined process env.
    STRIPE_API_KEY:
      readOptionalStringBinding(workerEnv, "STRIPE_API_KEY") ?? parsedEnv.STRIPE_API_KEY,
    STRIPE_CONNECT_WEBHOOK_SECRET:
      readOptionalStringBinding(workerEnv, "STRIPE_CONNECT_WEBHOOK_SECRET") ??
      parsedEnv.STRIPE_CONNECT_WEBHOOK_SECRET,
  }
}

export type Env = ReturnType<typeof createRuntimeEnv>
