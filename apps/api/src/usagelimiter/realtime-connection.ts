export type RealtimeConnectionState = {
  joinedAt: number
  lastActiveAt: number
  tailActive: boolean
  tailExpiredAt: number | null
}

export function getRealtimeConnectionLastActiveAt(
  state: RealtimeConnectionState | null | undefined,
  fallbackAt: number
): number {
  return state?.lastActiveAt ?? state?.joinedAt ?? fallbackAt
}

export function shouldCloseRealtimeConnection(
  state: RealtimeConnectionState | null | undefined,
  now: number,
  maxIdleConnectionMs: number
): boolean {
  return now - getRealtimeConnectionLastActiveAt(state, now) > maxIdleConnectionMs
}

export function shouldExpireRealtimeTail(
  state: RealtimeConnectionState | null | undefined,
  now: number,
  maxDebugSessionMs: number
): boolean {
  const joinedAt = state?.joinedAt ?? now
  const tailActive = state?.tailActive ?? true

  return tailActive && now - joinedAt > maxDebugSessionMs
}
