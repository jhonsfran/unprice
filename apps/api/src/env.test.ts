import { describe, expect, it } from "vitest"
import { resolveRealtimeTicketSecret } from "./env"

const authSecret = "a".repeat(32)
const realtimeSecret = "b".repeat(32)

describe("resolveRealtimeTicketSecret", () => {
  it("falls back to AUTH_SECRET in development", () => {
    expect(
      resolveRealtimeTicketSecret({
        APP_ENV: "development",
        AUTH_SECRET: authSecret,
      })
    ).toBe(authSecret)
  })

  it("uses REALTIME_TICKET_SECRET in development when provided", () => {
    expect(
      resolveRealtimeTicketSecret({
        APP_ENV: "development",
        AUTH_SECRET: authSecret,
        REALTIME_TICKET_SECRET: realtimeSecret,
      })
    ).toBe(realtimeSecret)
  })

  it("requires REALTIME_TICKET_SECRET outside development", () => {
    expect(() =>
      resolveRealtimeTicketSecret({
        APP_ENV: "production",
        AUTH_SECRET: authSecret,
      })
    ).toThrow("REALTIME_TICKET_SECRET binding is required outside development")
  })

  it("rejects realtime ticket secrets that reuse AUTH_SECRET outside development", () => {
    expect(() =>
      resolveRealtimeTicketSecret({
        APP_ENV: "preview",
        AUTH_SECRET: authSecret,
        REALTIME_TICKET_SECRET: authSecret,
      })
    ).toThrow("REALTIME_TICKET_SECRET must be distinct from AUTH_SECRET")
  })
})
