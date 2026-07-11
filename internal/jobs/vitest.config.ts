import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Schedule tests import the Trigger SDK and can run under heavy Turbo
    // contention when the workspace test suite is executed in parallel.
    testTimeout: 15_000,
    env: {
      APP_ENV: "test",
      NODE_ENV: "test",
      SKIP_ENV_VALIDATION: "true",
    },
  },
})
