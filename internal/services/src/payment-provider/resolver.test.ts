import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import { PaymentProviderResolver } from "./resolver"

vi.mock("../../env", () => ({
  env: {
    ENCRYPTION_KEY: "test_encryption_key",
    NODE_ENV: "test",
  },
}))

vi.mock("@unprice/db/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@unprice/db/utils")>()

  return {
    ...actual,
    AesGCM: {
      withBase64Key: vi.fn().mockResolvedValue({
        decrypt: vi.fn().mockImplementation(async ({ ciphertext }: { ciphertext: string }) => {
          if (ciphertext === "encrypted-key") {
            return "decrypted-key"
          }

          if (ciphertext === "encrypted-webhook") {
            return "sandbox-secret"
          }

          return "decrypted-value"
        }),
      }),
    },
  }
})

function createMockLogger(): Logger {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createMockDb(): Database {
  return {
    query: {
      customers: {
        findFirst: vi.fn().mockResolvedValue({
          id: "cus_1",
          projectId: "proj_1",
        }),
      },
      customerProviderIds: {
        findFirst: vi.fn().mockResolvedValue({
          id: "cp_1",
          projectId: "proj_1",
          customerId: "cus_1",
          provider: "sandbox",
          providerCustomerId: "provider_customer_1",
          metadata: {
            setupSessionId: "sess_1",
          },
        }),
      },
      paymentProviderConfig: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ppc_1",
          projectId: "proj_1",
          paymentProvider: "sandbox",
          key: "encrypted-key",
          keyIv: "iv-key",
          webhookSecret: "encrypted-webhook",
          webhookSecretIv: "iv-webhook",
          active: true,
        }),
      },
    },
  } as unknown as Database
}

describe("PaymentProviderResolver", () => {
  it("resolves provider customer id from mapping table and decrypts webhook secret", async () => {
    const resolver = new PaymentProviderResolver({
      db: createMockDb(),
      logger: createMockLogger(),
    })

    const resolved = await resolver.resolve({
      customerId: "cus_1",
      projectId: "proj_1",
      provider: "sandbox",
    })

    expect(resolved.err).toBeUndefined()
    expect(resolved.val).toBeDefined()
    expect(resolved.val?.getCustomerId()).toBe("provider_customer_1")

    const verifyOk = await resolved.val?.verifyWebhook({
      rawBody: JSON.stringify({
        id: "evt_1",
        type: "sandbox.test",
      }),
      signature: "sandbox_webhook_secret",
    })

    expect(verifyOk?.err).toBeUndefined()

    const verifyErr = await resolved.val?.verifyWebhook({
      rawBody: JSON.stringify({
        id: "evt_1",
        type: "sandbox.test",
      }),
      signature: "invalid-secret",
    })

    expect(verifyErr?.err).toBeDefined()
  })

  it("resolves sandbox without a paymentProviderConfig row", async () => {
    const db = createMockDb()
    db.query.paymentProviderConfig.findFirst = vi.fn().mockResolvedValue(null)

    const resolver = new PaymentProviderResolver({
      db,
      logger: createMockLogger(),
    })

    const resolved = await resolver.resolve({
      customerId: "cus_1",
      projectId: "proj_1",
      provider: "sandbox",
    })

    expect(resolved.err).toBeUndefined()
    expect(resolved.val?.getCustomerId()).toBe("provider_customer_1")
  })
})
