import type { AppLogger } from "@unprice/observability"
import type { CustomerService } from "@unprice/services/customers"
import type { GrantsManager } from "@unprice/services/entitlements"
import { describe, expect, it, vi } from "vitest"
import { CloudflareEntitlementWindowClient, CloudflareIdempotencyClient } from "./clients"
import { createIngestionService } from "./service"

describe("createIngestionService", () => {
  it("builds the ingestion service with shared cloudflare clients", () => {
    const pipelineEvents = {
      send: vi.fn(),
    }

    const env = {
      APP_ENV: "development",
      entitlementwindow: {
        getByName: vi.fn(),
      },
      ingestionidempotency: {
        getByName: vi.fn(),
      },
      PIPELINE_EVENTS: pipelineEvents,
    }

    const service = createIngestionService({
      customerService: {} as CustomerService,
      grantsManager: {} as GrantsManager,
      logger: {
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as unknown as AppLogger,
      env,
    })

    const rawService = service as unknown as {
      entitlementWindowClient: unknown
      idempotencyClient: unknown
      pipelineEvents: unknown
    }

    expect(rawService.entitlementWindowClient).toBeInstanceOf(CloudflareEntitlementWindowClient)
    expect(rawService.idempotencyClient).toBeInstanceOf(CloudflareIdempotencyClient)
    expect(rawService.pipelineEvents).toBe(pipelineEvents)
  })
})
