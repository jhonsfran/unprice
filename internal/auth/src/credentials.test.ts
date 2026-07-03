import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  verifyPassword: vi.fn(async (_password: string, encoded: string) => encoded === "valid-hash"),
}))

vi.mock("./password", () => ({
  verifyPassword: mocks.verifyPassword,
}))

import { toCredentialsAuthUser, verifyCredentialsPassword } from "./credentials"

describe("credentials auth helpers", () => {
  it("runs a decoy password verification when the user has no password hash", async () => {
    const valid = await verifyCredentialsPassword({
      password: "candidate",
      passwordHash: null,
    })

    expect(valid).toBe(false)
    expect(mocks.verifyPassword).toHaveBeenCalledWith(
      "candidate",
      "pbkdf2$sha256$210000$AAAAAAAAAAAAAAAAAAAAAA$f2Tpn681FBg4tL6UX653B4WEnFBCNeUTwmuGcCbJzak"
    )
  })

  it("only accepts a real matching password hash", async () => {
    await expect(
      verifyCredentialsPassword({
        password: "candidate",
        passwordHash: "invalid-hash",
      })
    ).resolves.toBe(false)

    await expect(
      verifyCredentialsPassword({
        password: "candidate",
        passwordHash: "valid-hash",
      })
    ).resolves.toBe(true)
  })

  it("strips the password hash from the Auth.js user payload", () => {
    expect(
      toCredentialsAuthUser({
        id: "user_123",
        email: "user@example.com",
        name: "User",
        image: "https://example.com/avatar.png",
        password: "hashed-password",
      })
    ).toEqual({
      id: "user_123",
      email: "user@example.com",
      name: "User",
      image: "https://example.com/avatar.png",
    })
  })
})
