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

          if (ciphertext === "encrypted-webhook-a") {
            return "secret-a"
          }

          if (ciphertext === "encrypted-webhook-b") {
            return "secret-b"
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

function createMockDb(overrides?: {
  paymentProviderConfig?: Record<string, unknown> | null
  customerProviderIds?: Record<string, unknown> | null
}): Database {
  return {
    query: {
      customerProviderIds: {
        findFirst: vi.fn().mockResolvedValue(
          overrides?.customerProviderIds ?? {
            id: "cp_1",
            projectId: "proj_1",
            customerId: "cus_1",
            provider: "sandbox",
            providerCustomerId: "provider_customer_1",
            metadata: {
              setupSessionId: "sess_1",
            },
          }
        ),
      },
      paymentProviderConfig: {
        findFirst: vi.fn().mockResolvedValue(
          overrides?.paymentProviderConfig === null
            ? null
            : (overrides?.paymentProviderConfig ?? {
                id: "ppc_1",
                projectId: "proj_1",
                paymentProvider: "sandbox",
                key: "encrypted-key",
                keyIv: "iv-key",
                webhookSecret: "encrypted-webhook-a",
                webhookSecretIv: "iv-webhook-a",
                active: true,
              })
        ),
      },
    },
  } as unknown as Database
}

describe("PaymentProviderResolver", () => {
  it("resolves a configured sandbox provider and verifies webhooks against the operator-set secret", async () => {
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
      rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.test" }),
      signature: "secret-a",
    })

    expect(verifyOk?.err).toBeUndefined()

    const verifyWrong = await resolved.val?.verifyWebhook({
      rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.test" }),
      signature: "invalid-secret",
    })

    expect(verifyWrong?.err).toBeDefined()

    const verifyMissing = await resolved.val?.verifyWebhook({
      rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.test" }),
    })

    expect(verifyMissing?.err).toBeDefined()
  })

  it("returns PAYMENT_PROVIDER_CONFIG_NOT_FOUND when sandbox is unconfigured", async () => {
    const resolver = new PaymentProviderResolver({
      db: createMockDb({ paymentProviderConfig: null }),
      logger: createMockLogger(),
    })

    const resolved = await resolver.resolve({
      customerId: "cus_1",
      projectId: "proj_1",
      provider: "sandbox",
    })

    expect(resolved.err).toBeDefined()
    expect(resolved.err?.message).toMatch(/Payment provider config not found/)
  })

  it("rejects webhook verification when sandbox config has no webhook secret", async () => {
    const resolver = new PaymentProviderResolver({
      db: createMockDb({
        paymentProviderConfig: {
          id: "ppc_1",
          projectId: "proj_1",
          paymentProvider: "sandbox",
          key: "encrypted-key",
          keyIv: "iv-key",
          webhookSecret: null,
          webhookSecretIv: null,
          active: true,
        },
      }),
      logger: createMockLogger(),
    })

    const resolved = await resolver.resolve({
      customerId: "cus_1",
      projectId: "proj_1",
      provider: "sandbox",
    })

    expect(resolved.err).toBeUndefined()

    const verify = await resolved.val?.verifyWebhook({
      rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.test" }),
      signature: "anything",
    })

    expect(verify?.err).toBeDefined()
    expect(verify?.err?.message).toMatch(/secret not configured/)
  })

  it("isolates webhook secrets per project", async () => {
    const dbA = createMockDb({
      paymentProviderConfig: {
        id: "ppc_a",
        projectId: "proj_a",
        paymentProvider: "sandbox",
        key: "encrypted-key",
        keyIv: "iv-key",
        webhookSecret: "encrypted-webhook-a",
        webhookSecretIv: "iv-webhook-a",
        active: true,
      },
    })
    const dbB = createMockDb({
      paymentProviderConfig: {
        id: "ppc_b",
        projectId: "proj_b",
        paymentProvider: "sandbox",
        key: "encrypted-key",
        keyIv: "iv-key",
        webhookSecret: "encrypted-webhook-b",
        webhookSecretIv: "iv-webhook-b",
        active: true,
      },
    })

    const resolverA = new PaymentProviderResolver({ db: dbA, logger: createMockLogger() })
    const resolverB = new PaymentProviderResolver({ db: dbB, logger: createMockLogger() })

    const resolvedA = await resolverA.resolve({ projectId: "proj_a", provider: "sandbox" })
    const resolvedB = await resolverB.resolve({ projectId: "proj_b", provider: "sandbox" })

    // Project A's secret must not authenticate a project B webhook.
    const crossA = await resolvedB.val?.verifyWebhook({
      rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.test" }),
      signature: "secret-a",
    })
    expect(crossA?.err).toBeDefined()

    // Project B's secret must not authenticate a project A webhook.
    const crossB = await resolvedA.val?.verifyWebhook({
      rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.test" }),
      signature: "secret-b",
    })
    expect(crossB?.err).toBeDefined()

    // Each project's own secret authenticates its own webhook.
    const okA = await resolvedA.val?.verifyWebhook({
      rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.test" }),
      signature: "secret-a",
    })
    expect(okA?.err).toBeUndefined()

    const okB = await resolvedB.val?.verifyWebhook({
      rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.test" }),
      signature: "secret-b",
    })
    expect(okB?.err).toBeUndefined()
  })
})
