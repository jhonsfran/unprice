import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import { setProviderEnabled } from "./connection"

function createLogger(): Logger {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createDb(opts: {
  existing?: Record<string, unknown>
  insertResult?: Record<string, unknown>
  updateResult?: Record<string, unknown>
}) {
  const insertReturning = vi.fn().mockResolvedValue(opts.insertResult ? [opts.insertResult] : [])
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning: insertReturning })
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate })
  const insert = vi.fn().mockReturnValue({ values })

  const updateReturning = vi.fn().mockResolvedValue(opts.updateResult ? [opts.updateResult] : [])
  const where = vi.fn().mockReturnValue({ returning: updateReturning })
  const set = vi.fn().mockReturnValue({ where })
  const update = vi.fn().mockReturnValue({ set })

  const db = {
    query: {
      paymentProviderConfig: {
        findFirst: vi.fn().mockResolvedValue(opts.existing),
      },
    },
    insert,
    update,
  } as unknown as Database

  return {
    db,
    insert,
    values,
    onConflictDoUpdate,
    insertReturning,
    update,
    set,
    where,
    updateReturning,
  }
}

describe("provider connection enablement", () => {
  it("enables sandbox as a managed test config without project-owned keys", async () => {
    const sandboxConfig = {
      id: "ppc_sandbox",
      projectId: "proj_123",
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
    }
    const mocks = createDb({ insertResult: sandboxConfig })

    const result = await setProviderEnabled(
      { db: mocks.db, logger: createLogger() },
      {
        projectId: "proj_123",
        paymentProvider: "sandbox",
        enabled: true,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.paymentProviderConfig?.active).toBe(true)
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentProvider: "sandbox",
        active: true,
        connectionType: "managed_connection",
        mode: "test",
        status: "active",
        key: null,
        webhookSecret: null,
      })
    )
  })

  it("disables Stripe without deleting its connected account id", async () => {
    const stripeConfig = {
      id: "ppc_stripe",
      projectId: "proj_123",
      paymentProvider: "stripe",
      active: true,
      connectionType: "managed_connection",
      mode: "test",
      status: "active",
      externalAccountId: "acct_123",
    }
    const mocks = createDb({
      existing: stripeConfig,
      updateResult: {
        ...stripeConfig,
        active: false,
      },
    })

    const result = await setProviderEnabled(
      { db: mocks.db, logger: createLogger() },
      {
        projectId: "proj_123",
        paymentProvider: "stripe",
        enabled: false,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.paymentProviderConfig?.externalAccountId).toBe("acct_123")
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        active: false,
      })
    )
    expect(mocks.set).not.toHaveBeenCalledWith(expect.objectContaining({ externalAccountId: null }))
  })

  it("re-enables Stripe while preserving the existing connection", async () => {
    const stripeConfig = {
      id: "ppc_stripe",
      projectId: "proj_123",
      paymentProvider: "stripe",
      active: false,
      connectionType: "managed_connection",
      mode: "test",
      status: "active",
      externalAccountId: "acct_123",
    }
    const mocks = createDb({
      existing: stripeConfig,
      updateResult: {
        ...stripeConfig,
        active: true,
      },
    })

    const result = await setProviderEnabled(
      { db: mocks.db, logger: createLogger() },
      {
        projectId: "proj_123",
        paymentProvider: "stripe",
        enabled: true,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.paymentProviderConfig?.externalAccountId).toBe("acct_123")
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        active: true,
      })
    )
    expect(mocks.set).not.toHaveBeenCalledWith(expect.objectContaining({ externalAccountId: null }))
  })
})
