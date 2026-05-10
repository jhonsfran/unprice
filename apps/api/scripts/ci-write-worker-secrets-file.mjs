#!/usr/bin/env node
/**
 * Builds `.ci-worker-secrets.json` for `wrangler secret bulk` in CI **after** deploy.
 * `cloudflare/wrangler-action` runs `uploadSecrets` before `wrangler deploy` when
 * using `secrets:`; that can fail with API 10214. We omit `secrets:` and run
 * `secret bulk` in `postCommands` instead.
 *
 * @see .github/workflows/job_deploy_api.yaml
 */
import { writeFileSync } from "node:fs"

const SECRET_NAMES = [
  "TINYBIRD_TOKEN",
  "TINYBIRD_URL",
  "AUTH_SECRET",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_CACHE_DOMAIN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "LAKEHOUSE_API_TOKEN",
  "DATABASE_URL",
  "DATABASE_READ1_URL",
  "DATABASE_READ2_URL",
  "ENCRYPTION_KEY",
  "AXIOM_API_TOKEN",
  "AXIOM_DATASET",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "STRIPE_API_KEY",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "UNPRICE_API_KEY",
  "UNPRICE_API_URL",
]

const missing = []
const obj = {}
for (const name of SECRET_NAMES) {
  const value = process.env[name]
  if (value === undefined || value === "") {
    missing.push(name)
  } else {
    obj[name] = value
  }
}

if (missing.length > 0) {
  console.error("Missing required worker secrets:", missing.join(", "))
  process.exit(1)
}

writeFileSync(new URL("../.ci-worker-secrets.json", import.meta.url), JSON.stringify(obj))
