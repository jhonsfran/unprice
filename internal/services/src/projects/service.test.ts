import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { ProjectFeatureCache } from "../cache"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { ProjectService } from "./service"

function createLogger(): Logger {
  return {
    set: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    emit: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createProjectService(db: Database) {
  const cache = {
    projectFeatures: {
      swr: vi.fn((_key: string, fn: () => Promise<ProjectFeatureCache | null>) => fn()),
    },
  } as unknown as Cache

  return new ProjectService({
    db,
    logger: createLogger(),
    analytics: {} as unknown as Analytics,
    waitUntil: () => {},
    cache,
    metrics: { emit: vi.fn(), flush: vi.fn(), setColo: vi.fn() } as unknown as Metrics,
  })
}

describe("ProjectService createProjectRecord", () => {
  it("creates projects with an active managed sandbox provider", async () => {
    let insertedProject: Record<string, unknown> | undefined
    let insertedSandboxConfig: Record<string, unknown> | undefined

    const tx = {
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: Record<string, unknown>) => {
          if (table === schema.projects) {
            insertedProject = values
          }

          if (table === schema.paymentProviderConfig) {
            insertedSandboxConfig = values
          }

          const returning = vi.fn().mockResolvedValue([{ ...values }])

          return {
            onConflictDoUpdate: vi.fn(() => ({ returning })),
            returning,
          }
        }),
      })),
    }

    const db = {
      transaction: vi.fn((callback: (txArg: unknown) => Promise<unknown>) => callback(tx)),
    } as unknown as Database

    const { val, err } = await createProjectService(db).createProjectRecord({
      workspaceId: "ws_123",
      workspaceIsInternal: false,
      name: "New Project",
      defaultCurrency: "USD",
      timezone: "UTC",
      contactEmail: "owner@example.com",
    })

    expect(err).toBeUndefined()
    expect(val?.id).toBe(insertedProject?.id)
    expect(insertedSandboxConfig).toMatchObject({
      projectId: insertedProject?.id,
      paymentProvider: "sandbox",
      active: true,
      connectionType: "managed_connection",
      mode: "test",
      status: "active",
      key: null,
      keyIv: null,
      webhookSecret: null,
      webhookSecretIv: null,
      externalAccountId: null,
      connectionData: null,
    })
  })
})
