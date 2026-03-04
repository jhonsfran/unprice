"use client"

import type { PropsWithChildren } from "react"
import {
  type EntitlementValidationEvent,
  type RealtimeAlertEvent,
  type RealtimeStreamMode,
  type RealtimeTokenPayload,
  type RealtimeWindowSeconds,
  type SubscriptionStatus,
  UnpriceEntitlementsRealtimeProvider,
} from "./realtime"

export type RealtimeTicketReason = "init" | "pre_expiry" | "expired" | "reconnect" | "manual"

export type UnpriceProviderMode = "manual" | "auto"

export type UnpriceRealtimeConfig = {
  mode?: UnpriceProviderMode
  customerId: string
  projectId: string
  runtimeEnv?: string
  apiBaseUrl?: string
  snapshotWindowSeconds?: RealtimeWindowSeconds
  initialTicket?: RealtimeTokenPayload | null
  getRealtimeTicket: (params: {
    customerId: string
    projectId: string
    reason: RealtimeTicketReason
    currentExpiresAt: number | null
  }) => Promise<RealtimeTokenPayload>
  onTokenRefresh?: (payload: RealtimeTokenPayload) => void
  refreshLeadSeconds?: number
  snapshotStaleThresholdMs?: number
  snapshotRetryIntervalMs?: number
  disableWebsocket?: boolean
  eventBufferSize?: number
  stream?: RealtimeStreamMode
  onValidationEvent?: (event: EntitlementValidationEvent) => void
  onAlertEvent?: (event: RealtimeAlertEvent) => void
  onConnectionStateChange?: (value: {
    status: "idle" | "connecting" | "open" | "closed" | "error"
    attempts: number
    lastError: string | null
  }) => void
}

export type UnpriceProviderProps = PropsWithChildren<{
  realtime: UnpriceRealtimeConfig
}>

export type { SubscriptionStatus }

export function createUnpriceRealtimeClient(config: UnpriceRealtimeConfig): UnpriceRealtimeConfig {
  if (config.mode !== "auto") {
    return config
  }

  return {
    ...config,
    stream: config.stream ?? "all",
    refreshLeadSeconds: config.refreshLeadSeconds ?? 45,
    snapshotStaleThresholdMs: config.snapshotStaleThresholdMs ?? 15_000,
    snapshotRetryIntervalMs: config.snapshotRetryIntervalMs ?? 8_000,
    eventBufferSize: config.eventBufferSize ?? 100,
  }
}

export function UnpriceProvider({ children, realtime }: UnpriceProviderProps) {
  const resolvedRealtime = createUnpriceRealtimeClient(realtime)
  return (
    <UnpriceEntitlementsRealtimeProvider
      customerId={resolvedRealtime.customerId}
      projectId={resolvedRealtime.projectId}
      runtimeEnv={resolvedRealtime.runtimeEnv}
      apiBaseUrl={resolvedRealtime.apiBaseUrl}
      snapshotWindowSeconds={resolvedRealtime.snapshotWindowSeconds}
      initialRealtimeToken={resolvedRealtime.initialTicket?.ticket ?? null}
      initialRealtimeTokenExpiresAt={resolvedRealtime.initialTicket?.expiresAt ?? null}
      getRealtimeTicket={resolvedRealtime.getRealtimeTicket}
      onRealtimeTokenRefresh={resolvedRealtime.onTokenRefresh}
      refreshLeadSeconds={resolvedRealtime.refreshLeadSeconds}
      snapshotStaleThresholdMs={resolvedRealtime.snapshotStaleThresholdMs}
      snapshotRetryIntervalMs={resolvedRealtime.snapshotRetryIntervalMs}
      disableWebsocket={resolvedRealtime.disableWebsocket}
      eventBufferSize={resolvedRealtime.eventBufferSize}
      stream={resolvedRealtime.stream}
      onValidationEvent={resolvedRealtime.onValidationEvent}
      onAlertEvent={resolvedRealtime.onAlertEvent}
      onConnectionStateChange={resolvedRealtime.onConnectionStateChange}
    >
      {children}
    </UnpriceEntitlementsRealtimeProvider>
  )
}
