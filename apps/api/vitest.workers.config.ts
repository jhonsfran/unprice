import { resolve } from "node:path"
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"

Object.assign(process.env, {
  NODE_ENV: "test",
  APP_ENV: "development",
  SKIP_ENV_VALIDATION: "true",
  AUTH_SECRET: "test_auth_secret_000000000000000000",
  REALTIME_TICKET_SECRET: "test_realtime_secret_000000000000000",
  CLOUDFLARE_ACCOUNT_ID: "test_account",
  DATABASE_URL: "postgres://user:pass@localhost:5432/unprice",
  DATABASE_READ1_URL: "postgres://user:pass@localhost:5432/unprice",
  DATABASE_READ2_URL: "postgres://user:pass@localhost:5432/unprice",
  TINYBIRD_TOKEN: "test_tinybird_token",
  TINYBIRD_URL: "https://example.com",
  AXIOM_API_TOKEN: "",
  AXIOM_DATASET: "",
  ENCRYPTION_KEY: "test_encryption_key",
  UNPRICE_API_KEY: "test_unprice_api_key",
})

export default defineWorkersConfig({
  resolve: {
    alias: {
      "cloudflare:test": resolve(__dirname, "test-support/cloudflare-test.ts"),
      "~": resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.workers.test.ts"],
    pool: "@cloudflare/vitest-pool-workers",
    poolOptions: {
      workers: {
        main: "./src/worker-runtime-entry.ts",
        wrangler: {
          configPath: "./wrangler.jsonc",
          environment: "dev",
        },
        miniflare: {
          bindings: {
            APP_ENV: "development",
            NODE_ENV: "test",
            SKIP_ENV_VALIDATION: "true",
            AUTH_SECRET: "test_auth_secret_000000000000000000",
            REALTIME_TICKET_SECRET: "test_realtime_secret_000000000000000",
            CLOUDFLARE_ACCOUNT_ID: "test_account",
            DATABASE_URL: "postgres://user:pass@localhost:5432/unprice",
            DATABASE_READ1_URL: "postgres://user:pass@localhost:5432/unprice",
            DATABASE_READ2_URL: "postgres://user:pass@localhost:5432/unprice",
            TINYBIRD_TOKEN: "test_tinybird_token",
            TINYBIRD_URL: "https://example.com",
            AXIOM_API_TOKEN: "",
            AXIOM_DATASET: "",
          },
        },
      },
    },
    testTimeout: 20_000,
    env: {
      NODE_ENV: "test",
      APP_ENV: "development",
      SKIP_ENV_VALIDATION: "true",
    },
  },
})
