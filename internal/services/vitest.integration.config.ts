import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    reporters: ["default"],
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    maxConcurrency: 1,
    testTimeout: 10000,
    alias: {
      "@/": "./src/",
    },
    globalSetup: ["./src/test-fixtures/global-setup.ts"],
    env: {
      SKIP_ENV_VALIDATION: "true",
      NODE_ENV: "test",
      APP_ENV: "test",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/unprice_test",
      UNPRICE_API_KEY: "test_key",
    },
  },
})
