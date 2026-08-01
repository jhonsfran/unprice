import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "~": resolve(__dirname, "src"),
    },
  },
  test: {
    env: {
      APP_ENV: "development",
      NODE_ENV: "test",
      NEXT_PUBLIC_APP_DOMAIN: "localhost:3000",
      SKIP_ENV_VALIDATION: "true",
    },
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
})
