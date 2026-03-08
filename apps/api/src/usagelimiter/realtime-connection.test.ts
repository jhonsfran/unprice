import { describe, expect, it } from "vitest"
import {
  type RealtimeConnectionState,
  getRealtimeConnectionLastActiveAt,
  shouldCloseRealtimeConnection,
  shouldExpireRealtimeTail,
} from "./realtime-connection"

describe("realtime connection helpers", () => {
  it("falls back to joinedAt when legacy state has no lastActiveAt", () => {
    const legacyState = {
      joinedAt: 10_000,
      tailActive: true,
      tailExpiredAt: null,
    } as RealtimeConnectionState

    expect(getRealtimeConnectionLastActiveAt(legacyState, 20_000)).toBe(10_000)
  })

  it("closes connections that stay idle past the timeout", () => {
    const state: RealtimeConnectionState = {
      joinedAt: 1_000,
      lastActiveAt: 10_000,
      tailActive: true,
      tailExpiredAt: null,
    }

    expect(shouldCloseRealtimeConnection(state, 20_000, 5_000)).toBe(true)
    expect(shouldCloseRealtimeConnection(state, 14_000, 5_000)).toBe(false)
  })

  it("expires the tail channel after the debug session lifetime", () => {
    const state: RealtimeConnectionState = {
      joinedAt: 5_000,
      lastActiveAt: 12_000,
      tailActive: true,
      tailExpiredAt: null,
    }

    expect(shouldExpireRealtimeTail(state, 11_000, 5_000)).toBe(true)
    expect(shouldExpireRealtimeTail(state, 9_000, 5_000)).toBe(false)
  })

  it("does not re-expire a tail channel that is already paused", () => {
    const state: RealtimeConnectionState = {
      joinedAt: 5_000,
      lastActiveAt: 12_000,
      tailActive: false,
      tailExpiredAt: 12_000,
    }

    expect(shouldExpireRealtimeTail(state, 20_000, 5_000)).toBe(false)
  })
})
