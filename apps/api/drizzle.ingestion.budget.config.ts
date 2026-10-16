import { defineConfig } from "drizzle-kit"

export default defineConfig({
  out: "./src/ingestion/budget/drizzle",
  schema: "./src/ingestion/budget/db/schema.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
})
