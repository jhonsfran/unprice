import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import { SandboxPaymentProvider } from "./sandbox"

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

describe("SandboxPaymentProvider", () => {
  it("rejects every webhook when no secret is configured", async () => {
    const provider = new SandboxPaymentProvider({
      logger: createMockLogger(),
    })

    const res = await provider.verifyWebhook({
      rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.payment.succeeded" }),
      signature: "anything",
    })

    expect(res.err).toBeDefined()
    expect(res.err?.message).toMatch(/secret not configured/)
  })

  describe("verifyWebhook", () => {
    const secret = "sandbox_test_secret"

    function makeProvider(logger = createMockLogger()) {
      return {
        logger,
        provider: new SandboxPaymentProvider({
          logger,
          webhookSecret: secret,
        }),
      }
    }

    it("rejects when signature header is missing", async () => {
      const { provider, logger } = makeProvider()

      const res = await provider.verifyWebhook({
        rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.payment.succeeded" }),
      })

      expect(res.err).toBeDefined()
      expect(res.err?.message).toMatch(/Missing sandbox webhook signature/)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("missing signature"),
        expect.objectContaining({ provider: "sandbox" })
      )
    })

    it("rejects when signature is wrong", async () => {
      const { provider, logger } = makeProvider()

      const res = await provider.verifyWebhook({
        rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.payment.succeeded" }),
        signature: "wrong-secret",
      })

      expect(res.err).toBeDefined()
      expect(res.err?.message).toMatch(/Invalid sandbox webhook signature/)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid signature"),
        expect.objectContaining({ provider: "sandbox" })
      )
    })

    it("rejects when signature length differs (no early-exit timing leak)", async () => {
      const { provider } = makeProvider()

      const res = await provider.verifyWebhook({
        rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.payment.succeeded" }),
        signature: "x",
      })

      expect(res.err).toBeDefined()
      expect(res.err?.message).toMatch(/Invalid sandbox webhook signature/)
    })

    it("accepts when signature matches the configured secret", async () => {
      const { provider } = makeProvider()

      const res = await provider.verifyWebhook({
        rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.payment.succeeded" }),
        signature: secret,
      })

      expect(res.err).toBeUndefined()
      expect(res.val?.eventId).toBe("evt_1")
      expect(res.val?.eventType).toBe("sandbox.payment.succeeded")
    })

    it("reads signature from sandbox-signature header when not passed directly", async () => {
      const { provider } = makeProvider()

      const res = await provider.verifyWebhook({
        rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.payment.succeeded" }),
        headers: { "sandbox-signature": secret },
      })

      expect(res.err).toBeUndefined()
    })

    it("honors per-call secret override", async () => {
      const { provider } = makeProvider()
      const overrideSecret = "override_secret"

      const res = await provider.verifyWebhook({
        rawBody: JSON.stringify({ id: "evt_1", type: "sandbox.payment.succeeded" }),
        signature: overrideSecret,
        secret: overrideSecret,
      })

      expect(res.err).toBeUndefined()
    })
  })
})
