import { defineConfig } from "drizzle-kit"

export default defineConfig({
  out: "./src/ingestion/run-budget/drizzle",
  schema: "./src/ingestion/run-budget/db/schema.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
})
