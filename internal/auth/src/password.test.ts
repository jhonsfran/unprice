import { describe, expect, it } from "vitest"
import { hashPassword, verifyPassword } from "./password"

describe("password hashing", () => {
  it("hash/verify round-trip succeeds", async () => {
    const plain = "correct horse battery staple"
    const encoded = await hashPassword(plain)

    expect(encoded.startsWith("pbkdf2$sha256$210000$")).toBe(true)
    await expect(verifyPassword(plain, encoded)).resolves.toBe(true)
  })

  it("wrong password fails", async () => {
    const encoded = await hashPassword("super-secret")

    await expect(verifyPassword("wrong-password", encoded)).resolves.toBe(false)
  })

  it("malformed encoded hash fails safely", async () => {
    await expect(verifyPassword("password", "pbkdf2$sha256$210000$bad$hash")).resolves.toBe(false)
    await expect(verifyPassword("password", "not-a-valid-hash")).resolves.toBe(false)
  })
})
