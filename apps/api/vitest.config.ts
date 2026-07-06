import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "~": resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.workers.test.ts"],
    testTimeout: 15_000,
    env: {
      NODE_ENV: "test",
      APP_ENV: "test",
      SKIP_ENV_VALIDATION: "true",
    },
  },
})
