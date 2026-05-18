import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    reporters: ["default"],
    include: ["src/**/*.test.ts", "src/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
    alias: {
      "@/": "./src/",
    },
    env: {
      SKIP_ENV_VALIDATION: "true",
      NODE_ENV: "test",
      // Provide a dummy value just in case validation isn't fully skipped for some reason,
      // or if some other part of the code blindly tries to use it.
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/unprice_test",
      UNPRICE_API_KEY: "test_key",
    },
  },
})
