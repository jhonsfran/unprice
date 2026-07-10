import { describe, expect, it } from "vitest"
import { classifyIngestionQueue } from "./queue-routing"

describe("classifyIngestionQueue", () => {
  it("classifies every configured queue name across envs", () => {
    for (const env of ["prod", "preview", "dev"]) {
      expect(classifyIngestionQueue(`unprice-api-ingestion-shard-0-${env}`)).toBe("raw")
      expect(classifyIngestionQueue(`unprice-api-ingestion-reporting-${env}`)).toBe("reporting")
      expect(classifyIngestionQueue(`unprice-api-ingestion-dlq-${env}`)).toBe("raw_dlq")
      expect(classifyIngestionQueue(`unprice-api-ingestion-reporting-dlq-${env}`)).toBe(
        "reporting_dlq"
      )
    }
  })

  it("treats unknown queues as raw so a rename cannot silently drop events", () => {
    expect(classifyIngestionQueue("unprice-api-ingestion-shard-9-prod")).toBe("raw")
  })

  it("does not classify prefixed lookalikes as special queues", () => {
    expect(classifyIngestionQueue("not-unprice-api-ingestion-reporting-prod")).toBe("raw")
    expect(classifyIngestionQueue("foo-unprice-api-ingestion-dlq-prod")).toBe("raw")
  })

  it("accepts legitimate environment suffixes", () => {
    expect(classifyIngestionQueue("unprice-api-ingestion-reporting-staging-eu")).toBe("reporting")
    expect(classifyIngestionQueue("unprice-api-ingestion-dlq-local-test")).toBe("raw_dlq")
    expect(classifyIngestionQueue("unprice-api-ingestion-reporting-dlq-local-test")).toBe(
      "reporting_dlq"
    )
  })
})
