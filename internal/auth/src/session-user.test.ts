import { describe, expect, it, vi } from "vitest"
import { keepTokenIfUserExists } from "./session-user"

describe("keepTokenIfUserExists", () => {
  const token = { sub: "usr_1", email: "a@b.co" }

  it("keeps the token when the user still exists", async () => {
    const userExists = vi.fn(async () => true)

    expect(await keepTokenIfUserExists({ token, isSignIn: false, userExists })).toBe(token)
    expect(userExists).toHaveBeenCalledWith("usr_1")
  })

  it("drops the token when the user was deleted", async () => {
    const userExists = vi.fn(async () => false)

    expect(await keepTokenIfUserExists({ token, isSignIn: false, userExists })).toBeNull()
  })

  it("skips the lookup on sign-in", async () => {
    const userExists = vi.fn(async () => false)

    expect(await keepTokenIfUserExists({ token, isSignIn: true, userExists })).toBe(token)
    expect(userExists).not.toHaveBeenCalled()
  })

  it("skips the lookup for tokens without a subject", async () => {
    const userExists = vi.fn(async () => false)
    const anonymous = { email: "a@b.co" }

    expect(await keepTokenIfUserExists({ token: anonymous, isSignIn: false, userExists })).toBe(
      anonymous
    )
    expect(userExists).not.toHaveBeenCalled()
  })

  it("keeps the token when the lookup fails", async () => {
    const onError = vi.fn()
    const userExists = vi.fn(async () => {
      throw new Error("db down")
    })

    expect(await keepTokenIfUserExists({ token, isSignIn: false, userExists, onError })).toBe(token)
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
