import { describe, expect, it } from "vitest"
import { createHttpConnection } from "./createConnection"

const url = "postgresql://user:password@ep-example-123456.us-east-2.aws.neon.tech/neondb"

describe("createHttpConnection", () => {
  it("returns null in development, where only the WebSocket proxy runs", () => {
    expect(
      createHttpConnection({ env: "development", primaryDatabaseUrl: url, logger: false })
    ).toBeNull()
  })

  it("reuses the client for the same connection string", () => {
    const a = createHttpConnection({ env: "production", primaryDatabaseUrl: url, logger: false })
    const b = createHttpConnection({ env: "production", primaryDatabaseUrl: url, logger: false })

    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  it("builds the relational api key lookup without opening a connection", () => {
    const db = createHttpConnection({ env: "preview", primaryDatabaseUrl: url, logger: false })
    if (!db) throw new Error("expected an http connection")

    const { sql } = db.query.apikeys
      .findFirst({
        columns: { id: true, projectId: true },
        with: {
          project: {
            columns: { id: true, enabled: true },
            with: { workspace: { columns: { enabled: true } } },
          },
        },
        where: (apikey, { eq }) => eq(apikey.hash, "hash_123"),
      })
      .toSQL()

    expect(sql).toContain("unprice_apikeys")
    expect(sql).toContain("unprice_projects")
    expect(sql).toContain("unprice_workspaces")
  })
})
