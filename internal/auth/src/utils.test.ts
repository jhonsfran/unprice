import * as schema from "@unprice/db/schema"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  type InsertCall = {
    table: unknown
    values: Record<string, unknown>
  }

  const state = {
    returningRows: [] as Array<Record<string, unknown>>,
    insertCalls: [] as InsertCall[],
    conflictUpdate: undefined as { set?: Record<string, unknown> } | undefined,
    conflictDoNothing: undefined as { target?: unknown } | undefined,
  }

  const reset = () => {
    state.returningRows = []
    state.insertCalls = []
    state.conflictUpdate = undefined
    state.conflictDoNothing = undefined
  }

  const db = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        state.insertCalls.push({ table, values })

        return {
          onConflictDoUpdate: vi.fn((opts: { set?: Record<string, unknown> }) => {
            state.conflictUpdate = opts

            return {
              returning: vi.fn(() => Promise.resolve(state.returningRows)),
            }
          }),
          onConflictDoNothing: vi.fn((opts?: { target?: unknown }) => {
            state.conflictDoNothing = opts

            return {
              returning: vi.fn(() => Promise.resolve(state.returningRows)),
            }
          }),
        }
      }),
    })),
    query: {
      invites: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
    update: vi.fn(),
  }

  return {
    db,
    reset,
    state,
  }
})

vi.mock("./db", () => ({
  db: mocks.db,
}))

vi.mock("./password", () => ({
  hashPassword: vi.fn(async (password: string) => `hashed:${password}`),
}))

vi.mock("@unprice/db/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@unprice/db/utils")>()

  return {
    ...actual,
    newId: vi.fn(() => "user_test"),
  }
})

import { createCredentialsUser, createUserFromProvider } from "./utils"

describe("auth user creation", () => {
  beforeEach(() => {
    mocks.reset()
    vi.clearAllMocks()
  })

  it("does not update an existing user during credentials signup", async () => {
    const result = await createCredentialsUser({
      email: "victim@example.com",
      password: "new-password",
      confirmPassword: "new-password",
      name: "Attacker",
      emailVerified: null,
    })

    expect(result.err?.message).toBe("Unable to create account with these credentials")
    expect(result.val).toBeUndefined()
    expect(mocks.state.conflictDoNothing?.target).toBe(schema.users.email)
    expect(mocks.state.conflictUpdate).toBeUndefined()
    expect(mocks.state.insertCalls[0]?.values).toMatchObject({
      email: "victim@example.com",
      password: "hashed:new-password",
    })
  })

  it("does not set or overwrite a password during provider user upsert", async () => {
    mocks.state.returningRows = [
      {
        id: "user_existing",
        email: "oauth@example.com",
        name: "OAuth User",
        image: null,
        emailVerified: new Date("2026-07-03T00:00:00.000Z"),
        theme: "dark",
        defaultWorkspaceSlug: null,
        password: null,
        onboardingCompleted: false,
        onboardingCompletedAt: null,
      },
    ]

    const result = await createUserFromProvider({
      email: "oauth@example.com",
      name: "OAuth User",
      image: "https://example.com/avatar.png",
      emailVerified: new Date("2026-07-03T00:00:00.000Z"),
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.id).toBe("user_existing")
    expect(mocks.state.insertCalls[0]?.values.password).toBeNull()
    expect(mocks.state.conflictUpdate?.set).toEqual({
      name: "OAuth User",
      image: "https://example.com/avatar.png",
      emailVerified: new Date("2026-07-03T00:00:00.000Z"),
    })
    expect(mocks.state.conflictUpdate?.set).not.toHaveProperty("password")
  })
})
