import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("analytics router", () => {
  it("registers analytics router without lakehouse file plan", () => {
    const source = readFileSync(
      path.resolve(__dirname, "router/lambda/analytics/index.ts"),
      "utf-8"
    )
    const deletedProcedureName = ["getLakehouse", "FilePlan"].join("")

    expect(source).toContain("analyticsRouter")
    expect(source).not.toContain(deletedProcedureName)
  })

  it("registers project ingestion status analytics procedure", () => {
    const source = readFileSync(
      path.resolve(__dirname, "router/lambda/analytics/index.ts"),
      "utf-8"
    )

    expect(source).toContain("getIngestionStatus")
  })
})
