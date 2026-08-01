import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { sha256HexSync } from "./sha256-sync"

describe("sha256HexSync", () => {
  // Known-answer vectors: empty input, a single-block input, and an input long
  // enough to force a second padding block.
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("hashes %j", (input, expected) => {
    expect(sha256HexSync(input)).toBe(expected)
  })

  // The digest is hand-rolled because it has to stay synchronous in Workers and
  // browser bundles; cross-check it against a reference implementation over
  // multi-byte inputs and every padding boundary.
  it("matches node crypto across lengths, padding boundaries, and utf-8", () => {
    const inputs = [
      "ü — üñïçôdé",
      "🙂🙂🙂",
      ...Array.from({ length: 200 }, (_, length) => "x".repeat(length)),
    ]

    for (const input of inputs) {
      expect(sha256HexSync(input)).toBe(createHash("sha256").update(input, "utf8").digest("hex"))
    }
  })

  it("returns lowercase hex of a fixed width", () => {
    expect(sha256HexSync("anything")).toMatch(/^[0-9a-f]{64}$/)
  })
})
