import { getAllowedCorsOrigin } from "@unprice/config"
import { describe, expect, it } from "vitest"

describe("getAllowedCorsOrigin", () => {
  it("allows first-party origins", () => {
    expect(getAllowedCorsOrigin("https://app.unprice.dev")).toBe("https://app.unprice.dev")
    expect(getAllowedCorsOrigin("https://preview-api.unprice.dev")).toBe(
      "https://preview-api.unprice.dev"
    )
    expect(getAllowedCorsOrigin("https://tenant.builderai.sh")).toBe("https://tenant.builderai.sh")
  })

  it("allows configured preview aliases", () => {
    expect(getAllowedCorsOrigin("https://app-pr-123-unprice.vercel.app")).toBe(
      "https://app-pr-123-unprice.vercel.app"
    )
    expect(getAllowedCorsOrigin("https://api-pr-123-unprice.vercel.app")).toBe(
      "https://api-pr-123-unprice.vercel.app"
    )
  })

  it("allows localhost development origins", () => {
    expect(getAllowedCorsOrigin("http://localhost:3000")).toBe("http://localhost:3000")
    expect(getAllowedCorsOrigin("http://app.localhost:3001")).toBe("http://app.localhost:3001")
  })

  it("rejects untrusted or malformed origins", () => {
    expect(getAllowedCorsOrigin("https://example.com")).toBeNull()
    expect(getAllowedCorsOrigin("http://app.unprice.dev")).toBeNull()
    expect(getAllowedCorsOrigin("not a url")).toBeNull()
    expect(getAllowedCorsOrigin(null)).toBeNull()
  })
})
