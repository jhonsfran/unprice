import { describe, expect, it } from "vitest"
import {
  DEFAULT_RUN_RESERVATION_TTL_MS,
  MAX_RUN_RESERVATION_TTL_MS,
  resolveRunReservationExpiration,
} from "./expiration"

const NOW = Date.parse("2026-08-24T12:00:00.000Z")

describe("resolveRunReservationExpiration", () => {
  it.each([undefined, null])("defaults %s to one hour after start", (expiresAt) => {
    expect(resolveRunReservationExpiration({ expiresAt, now: NOW })).toEqual({
      valid: true,
      expiresAt: NOW + DEFAULT_RUN_RESERVATION_TTL_MS,
    })
  })

  it("preserves an explicit expiration within the allowed window", () => {
    const expiresAt = NOW + 2 * DEFAULT_RUN_RESERVATION_TTL_MS

    expect(resolveRunReservationExpiration({ expiresAt, now: NOW })).toEqual({
      valid: true,
      expiresAt,
    })
  })

  it("allows the exact 24-hour maximum", () => {
    const expiresAt = NOW + MAX_RUN_RESERVATION_TTL_MS

    expect(resolveRunReservationExpiration({ expiresAt, now: NOW })).toEqual({
      valid: true,
      expiresAt,
    })
  })

  it("rejects an expiration later than 24 hours after start", () => {
    expect(
      resolveRunReservationExpiration({
        expiresAt: NOW + MAX_RUN_RESERVATION_TTL_MS + 1,
        now: NOW,
      })
    ).toEqual({ valid: false, reason: "MAX_TTL_EXCEEDED" })
  })

  it("preserves a past expiration so the run expires immediately", () => {
    expect(resolveRunReservationExpiration({ expiresAt: NOW - 1, now: NOW })).toEqual({
      valid: true,
      expiresAt: NOW - 1,
    })
  })
})
