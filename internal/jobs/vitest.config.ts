import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 10_000,
    env: {
      APP_ENV: "test",
      NODE_ENV: "test",
      SKIP_ENV_VALIDATION: "true",
    },
  },
})
