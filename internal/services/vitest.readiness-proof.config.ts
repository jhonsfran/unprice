import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/billing/repository.readiness.proof.ts"],
    env: { SKIP_ENV_VALIDATION: "true", NODE_ENV: "test", APP_ENV: "test" },
  },
})
