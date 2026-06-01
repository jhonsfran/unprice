import type { Logger } from "@unprice/logs"
import type { Cache } from "@unprice/services/cache"
import type { EntitlementService } from "@unprice/services/entitlements"
import { describe, expect, it, vi } from "vitest"
import { CloudflareEntitlementWindowClient } from "./entitlements/client"
import { CloudflareReportingQueueClient } from "./reporting/client"
import { createIngestionService } from "./service"

describe("createIngestionService", () => {
  it("builds the ingestion service with shared cloudflare clients", () => {
    const env = {
      APP_ENV: "development",
      entitlementwindow: {
        getByName: vi.fn(),
      },
      INGESTION_REPORTING_QUEUE: {
        send: vi.fn(),
      },
    }

    const service = createIngestionService({
      cache: {
        ingestionPreparedGrantContext: {
          swr: vi.fn(),
        },
      } as unknown as Pick<Cache, "ingestionPreparedGrantContext">,
      entitlementService: {} as EntitlementService,
      logger: {
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as unknown as Logger,
      env,
      waitUntil: (_promise: Promise<unknown>): void => {
        throw new Error("Function not implemented.")
      },
    })

    const rawService = service as unknown as {
      entitlementWindowClient: unknown
      reportingClient: unknown
    }

    expect(rawService.entitlementWindowClient).toBeInstanceOf(CloudflareEntitlementWindowClient)
    expect(rawService.reportingClient).toBeInstanceOf(CloudflareReportingQueueClient)
  })
})
