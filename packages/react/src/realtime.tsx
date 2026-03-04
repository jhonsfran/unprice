"use client"

import type { paths } from "@unprice/api"
import { usePartySocket } from "partysocket/react"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { PropsWithChildren, ReactNode } from "react"

const SNAPSHOT_REQUEST_THROTTLE_MS = 1_500
const TOKEN_REFRESH_LEAD_SECONDS = 30
const DEFAULT_EVENT_BUFFER_SIZE = 50
const DEFAULT_API_BASE_URL = "https://api.unprice.dev"
const VERIFY_REQUEST_TIMEOUT_MS = 7_000
const MAX_TOKEN_REFRESH_RETRY_DELAY_MS = 30_000
const DEFAULT_SNAPSHOT_STALE_THRESHOLD_MS = 20_000
const DEFAULT_SNAPSHOT_RETRY_INTERVAL_MS = 10_000

export type RealtimeWindowSeconds = 300 | 3600 | 86400 | 604800
type RealtimeMetrics =
  paths["/v1/analytics/realtime"]["post"]["responses"]["200"]["content"]["application/json"]["metrics"]
export type VerifyEntitlementInput =
  paths["/v1/customer/verify"]["post"]["requestBody"]["content"]["application/json"]
export type VerifyEntitlementResult =
  paths["/v1/customer/verify"]["post"]["responses"]["200"]["content"]["application/json"]

export type SubscriptionStatus = "active" | "trialing" | "canceled" | "expired" | "past_due"

export type RealtimeEntitlement = {
  id: string
  featureSlug: string
  effectiveAt: number
  expiresAt: number | null
}

export type RealtimeFeatureState = {
  featureSlug: string
  featureType: "flat" | "tiered" | "usage" | "package"
  usage: number | null
  limit: number | null
  limitType: "hard" | "soft" | "none" | null
  effectiveAt: number | null
  expiresAt: number | null
}

export type RealtimeSubscriptionState = {
  status: SubscriptionStatus | null
  planSlug: string | null
  billingInterval: string | null
  phaseStartAt: number | null
  phaseEndAt: number | null
  cycleStartAt: number | null
  cycleEndAt: number | null
  timezone: string | null
}

export type RealtimeSnapshotState = {
  customerId: string
  projectId: string
  subscriptionStatus: SubscriptionStatus | null
  subscription?: RealtimeSubscriptionState | null
  entitlements: RealtimeEntitlement[]
  features: RealtimeFeatureState[]
  usageByFeature: Record<string, number>
  metrics: RealtimeMetrics
  asOf: number
  stateVersion: string
}

type SocketStatus = "idle" | "connecting" | "open" | "closed" | "error"
type RealtimeEventType = "verify" | "reportUsage"
type EventSource = "socket" | "hook"
type RealtimeTicketReason = "init" | "pre_expiry" | "expired" | "reconnect" | "manual"
type RealtimeAlertType = "limit_reached" | "limit_recovered"
export type RealtimeStreamMode = "all" | "events" | "alerts"

type SocketSender = {
  send: (message: string) => void
  readyState: number
}

type RealtimeClientMessageType = "snapshot_request" | "verify_request" | "resume_tail"

function buildRealtimeClientMessage<TPayload extends Record<string, unknown>>(
  type: RealtimeClientMessageType,
  payload: TPayload
): string {
  return JSON.stringify({
    type,
    ...payload,
  })
}

type PendingVerifyRequest = {
  resolve: (result: VerifyEntitlementResult) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
}

export type RealtimeTokenPayload = {
  ticket: string
  expiresAt: number
}

export type EntitlementRealtimeEvent = {
  at: number
  type: RealtimeEventType
  featureSlug: string
  success: boolean
  usage?: number
  limit?: number
  deniedReason?: VerifyEntitlementResult["deniedReason"]
  latencyMs?: number
  source: EventSource
}

export type EntitlementValidationEvent = {
  at: number
  featureSlug: string
  allowed: boolean
  deniedReason?: VerifyEntitlementResult["deniedReason"]
  usage?: number
  limit?: number
  message?: string
  source: EventSource
}

export type RealtimeAlertEvent = {
  at: number
  featureSlug: string
  alertType: RealtimeAlertType
  usage: number | null
  limit: number | null
  source: "socket"
}

export type UnpriceEntitlementsRealtimeProviderProps = PropsWithChildren<{
  customerId: string
  projectId: string
  runtimeEnv?: string
  apiBaseUrl?: string
  snapshotWindowSeconds?: RealtimeWindowSeconds
  initialRealtimeToken?: string | null
  initialRealtimeTokenExpiresAt?: number | null
  getRealtimeTicket: (params: {
    customerId: string
    projectId: string
    reason: RealtimeTicketReason
    currentExpiresAt: number | null
  }) => Promise<RealtimeTokenPayload>
  onRealtimeTokenRefresh?: (payload: RealtimeTokenPayload) => void
  refreshLeadSeconds?: number
  snapshotStaleThresholdMs?: number
  snapshotRetryIntervalMs?: number
  disableWebsocket?: boolean
  eventBufferSize?: number
  stream?: RealtimeStreamMode
  onValidationEvent?: (event: EntitlementValidationEvent) => void
  onAlertEvent?: (event: RealtimeAlertEvent) => void
  onConnectionStateChange?: (value: {
    status: SocketStatus
    attempts: number
    lastError: string | null
  }) => void
}>

type EntitlementsRealtimeContextValue = {
  customerId: string
  projectId: string
  subscriptionStatus: SubscriptionStatus | null
  subscription: RealtimeSubscriptionState | null
  entitlements: RealtimeEntitlement[]
  entitlementSlugs: Set<string>
  entitlementByFeatureSlug: Map<string, RealtimeEntitlement>
  features: RealtimeFeatureState[]
  usageByFeature: Record<string, number>
  metrics: RealtimeMetrics | null
  lastSnapshotAt: number | null
  stateVersion: string | null
  events: EntitlementRealtimeEvent[]
  alerts: RealtimeAlertEvent[]
  validationsByFeature: Record<string, EntitlementValidationEvent>
  lastValidationEvent: EntitlementValidationEvent | null
  socketStatus: SocketStatus
  eventStreamState: "active" | "paused"
  eventStreamPausedAt: number | null
  isConnected: boolean
  isRefreshingToken: boolean
  error: Error | null
  refreshRealtimeToken: () => Promise<void>
  refreshSnapshot: () => void
  resumeEventStream: () => void
  validateEntitlement: (input: VerifyEntitlementInput) => Promise<VerifyEntitlementResult>
}

export type UseEntitlementResult = {
  featureSlug: string
  entitlement: RealtimeEntitlement | null
  isEntitled: boolean
  isAllowed: boolean
  shouldRenderPaywall: boolean
  usage: number | null
  lastValidation: EntitlementValidationEvent | null
  validate: (
    input?: Omit<VerifyEntitlementInput, "featureSlug">
  ) => Promise<VerifyEntitlementResult>
}

export type UnpriceUsageSeedRow = {
  featureSlug: string
  usage?: number | null
  limit?: number | null
  limitType?: "hard" | "soft" | "none" | null
  featureType?: RealtimeFeatureState["featureType"] | null
}

export type UnpriceUsageRow = {
  featureSlug: string
  usage: number | null
  limit: number | null
  limitType: "hard" | "soft" | "none"
  featureType: RealtimeFeatureState["featureType"]
  hasLimit: boolean
  isFlatFeature: boolean
  allowsOverage: boolean
}

export type UseUnpriceUsageOptions = {
  featureSlugs?: string[]
  seedRows?: UnpriceUsageSeedRow[]
  scope?: "entitlements" | "all"
}

export type UseUnpriceUsageResult = {
  rows: UnpriceUsageRow[]
  byFeatureSlug: Map<string, UnpriceUsageRow>
  totalUsage: number
  meteredFeatureCount: number
  featuresAtOrOverLimit: number
}

const EntitlementsRealtimeContext = createContext<EntitlementsRealtimeContextValue | undefined>(
  undefined
)

function normalizeEpochSeconds(value: number | null | undefined): number | null {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return null
  }

  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
}

function normalizeEpochMilliseconds(value: number | null | undefined): number | null {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return null
  }

  if (value > 1_000_000_000_000) {
    return Math.floor(value)
  }

  return Math.floor(value * 1000)
}

function toWebSocketBaseUrl(input: string): string {
  const normalized = input.trim().replace(/\/+$/, "")

  if (normalized.startsWith("wss://") || normalized.startsWith("ws://")) {
    return normalized
  }

  if (normalized.startsWith("https://")) {
    return `wss://${normalized.slice("https://".length)}`
  }

  if (normalized.startsWith("http://")) {
    return `ws://${normalized.slice("http://".length)}`
  }

  return `wss://${normalized.replace(/^\/+/, "")}`
}

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error(fallbackMessage)
}

function createVerifyRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }

  return `verify_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === "number" ? value : undefined
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === "boolean" ? value : undefined
}

function readObject(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key]
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key]
  return Array.isArray(value) ? value : []
}

function parseSubscriptionStatus(value: unknown): SubscriptionStatus | null {
  if (
    value === "active" ||
    value === "trialing" ||
    value === "canceled" ||
    value === "expired" ||
    value === "past_due"
  ) {
    return value
  }
  return null
}

function parseRealtimeEntitlement(value: unknown): RealtimeEntitlement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  const input = value as Record<string, unknown>
  const id = readString(input, "id")
  const featureSlug = readString(input, "featureSlug")
  const effectiveAt = readNumber(input, "effectiveAt")
  const expiresAtRaw = input.expiresAt

  if (!id || !featureSlug || typeof effectiveAt !== "number") {
    return null
  }

  const expiresAt =
    typeof expiresAtRaw === "number" && Number.isFinite(expiresAtRaw) ? expiresAtRaw : null

  return {
    id,
    featureSlug,
    effectiveAt,
    expiresAt,
  }
}

function parseRealtimeFeature(value: unknown): RealtimeFeatureState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  const input = value as Record<string, unknown>
  const featureSlug = readString(input, "featureSlug")
  const featureType = readString(input, "featureType")

  if (!featureSlug) {
    return null
  }

  const normalizedFeatureType =
    featureType === "tier"
      ? "tiered"
      : featureType === "flat" ||
          featureType === "tiered" ||
          featureType === "usage" ||
          featureType === "package"
        ? featureType
        : null

  if (!normalizedFeatureType) {
    return null
  }

  const usage = readNumber(input, "usage")
  const limit = readNumber(input, "limit")
  const effectiveAt = readNumber(input, "effectiveAt")
  const expiresAt = readNumber(input, "expiresAt")
  const limitTypeRaw = readString(input, "limitType")
  const limitType =
    limitTypeRaw === "hard" || limitTypeRaw === "soft" || limitTypeRaw === "none"
      ? limitTypeRaw
      : null

  return {
    featureSlug,
    featureType: normalizedFeatureType,
    usage: typeof usage === "number" && Number.isFinite(usage) ? usage : null,
    limit: typeof limit === "number" && Number.isFinite(limit) ? limit : null,
    limitType,
    effectiveAt:
      typeof effectiveAt === "number" && Number.isFinite(effectiveAt) ? effectiveAt : null,
    expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null,
  }
}

function parseRealtimeSubscription(value: unknown): RealtimeSubscriptionState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  const input = value as Record<string, unknown>
  const planSlugRaw = input.planSlug
  const billingIntervalRaw = input.billingInterval
  const timezoneRaw = input.timezone

  return {
    status: parseSubscriptionStatus(input.status),
    planSlug: typeof planSlugRaw === "string" && planSlugRaw.trim().length > 0 ? planSlugRaw : null,
    billingInterval:
      typeof billingIntervalRaw === "string" && billingIntervalRaw.trim().length > 0
        ? billingIntervalRaw
        : null,
    phaseStartAt: normalizeEpochMilliseconds(readNumber(input, "phaseStartAt")),
    phaseEndAt: normalizeEpochMilliseconds(readNumber(input, "phaseEndAt")),
    cycleStartAt: normalizeEpochMilliseconds(readNumber(input, "cycleStartAt")),
    cycleEndAt: normalizeEpochMilliseconds(readNumber(input, "cycleEndAt")),
    timezone: typeof timezoneRaw === "string" && timezoneRaw.trim().length > 0 ? timezoneRaw : null,
  }
}

function parseUsageByFeature(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }

  const output: Record<string, number> = {}

  for (const [featureSlug, usage] of Object.entries(value)) {
    if (typeof usage === "number" && Number.isFinite(usage)) {
      output[featureSlug] = usage
    }
  }

  return output
}

function normalizeUsageValue(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null
  }
  return value
}

function normalizeLimitValue(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null
  }
  return value
}

function normalizeLimitType(
  value: "hard" | "soft" | "none" | null | undefined,
  hasLimit: boolean
): "hard" | "soft" | "none" {
  if (value === "hard" || value === "soft" || value === "none") {
    return value
  }
  return hasLimit ? "hard" : "none"
}

function normalizeFeatureType(
  value: RealtimeFeatureState["featureType"] | null | undefined
): RealtimeFeatureState["featureType"] {
  if (value === "flat" || value === "tiered" || value === "usage" || value === "package") {
    return value
  }
  return "usage"
}

export function UnpriceEntitlementsRealtimeProvider({
  children,
  customerId,
  projectId,
  runtimeEnv = "sdk",
  apiBaseUrl = DEFAULT_API_BASE_URL,
  snapshotWindowSeconds = 3600,
  initialRealtimeToken = null,
  initialRealtimeTokenExpiresAt = null,
  getRealtimeTicket,
  onRealtimeTokenRefresh,
  refreshLeadSeconds = TOKEN_REFRESH_LEAD_SECONDS,
  snapshotStaleThresholdMs = DEFAULT_SNAPSHOT_STALE_THRESHOLD_MS,
  snapshotRetryIntervalMs = DEFAULT_SNAPSHOT_RETRY_INTERVAL_MS,
  disableWebsocket = false,
  eventBufferSize = DEFAULT_EVENT_BUFFER_SIZE,
  stream = "all",
  onValidationEvent,
  onAlertEvent,
  onConnectionStateChange,
}: UnpriceEntitlementsRealtimeProviderProps) {
  const maxEvents = Math.max(1, Math.floor(eventBufferSize))

  const [activeRealtimeToken, setActiveRealtimeToken] = useState<string | null>(
    initialRealtimeToken
  )
  const [activeRealtimeTokenExpiresAt, setActiveRealtimeTokenExpiresAt] = useState<number | null>(
    normalizeEpochSeconds(initialRealtimeTokenExpiresAt)
  )
  const [isRealtimeTokenExpired, setIsRealtimeTokenExpired] = useState<boolean>(() => {
    const normalizedExpiresAt = normalizeEpochSeconds(initialRealtimeTokenExpiresAt)
    if (!initialRealtimeToken || !normalizedExpiresAt) {
      return true
    }
    return normalizedExpiresAt <= Math.floor(Date.now() / 1000)
  })
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("idle")
  const [isRefreshingToken, setIsRefreshingToken] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null)
  const [subscription, setSubscription] = useState<RealtimeSubscriptionState | null>(null)
  const [metrics, setMetrics] = useState<RealtimeMetrics | null>(null)
  const [entitlements, setEntitlements] = useState<RealtimeEntitlement[]>([])
  const [features, setFeatures] = useState<RealtimeFeatureState[]>([])
  const [usageByFeature, setUsageByFeature] = useState<Record<string, number>>({})
  const [lastSnapshotAt, setLastSnapshotAt] = useState<number | null>(null)
  const [stateVersion, setStateVersion] = useState<string | null>(null)
  const [events, setEvents] = useState<EntitlementRealtimeEvent[]>([])
  const [alerts, setAlerts] = useState<RealtimeAlertEvent[]>([])
  const [eventStreamPausedAt, setEventStreamPausedAt] = useState<number | null>(null)
  const [validationsByFeature, setValidationsByFeature] = useState<
    Record<string, EntitlementValidationEvent>
  >({})
  const [lastValidationEvent, setLastValidationEvent] = useState<EntitlementValidationEvent | null>(
    null
  )

  const isUnmountedRef = useRef(false)
  const partySocketRef = useRef<SocketSender | null>(null)
  const refreshPromiseRef = useRef<Promise<void> | null>(null)
  const pendingVerifyRequestsRef = useRef<Map<string, PendingVerifyRequest>>(new Map())
  const lastSnapshotRequestedAtRef = useRef(0)
  const hasAutoRefreshFailedRef = useRef(false)
  const refreshRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshRetryAttemptRef = useRef(0)
  const lastRefreshReasonRef = useRef<RealtimeTicketReason>("init")
  const lastRefreshErrorRef = useRef<string | null>(null)
  const activeRealtimeTokenRef = useRef<string | null>(activeRealtimeToken)
  const isRealtimeTokenExpiredRef = useRef(isRealtimeTokenExpired)
  const roomName = useMemo(
    () => `${runtimeEnv}:${projectId}:${customerId}`,
    [runtimeEnv, projectId, customerId]
  )
  const socketHost = useMemo(() => toWebSocketBaseUrl(apiBaseUrl), [apiBaseUrl])
  const isEventsStreamEnabled = stream !== "alerts"
  const isAlertsStreamEnabled = stream !== "events"
  const realtimeSocketEnabled =
    Boolean(activeRealtimeToken) && !isRealtimeTokenExpired && !disableWebsocket

  useEffect(() => {
    activeRealtimeTokenRef.current = activeRealtimeToken
  }, [activeRealtimeToken])

  useEffect(() => {
    isRealtimeTokenExpiredRef.current = isRealtimeTokenExpired
  }, [isRealtimeTokenExpired])

  useEffect(() => {
    setActiveRealtimeToken(initialRealtimeToken)
    setActiveRealtimeTokenExpiresAt(normalizeEpochSeconds(initialRealtimeTokenExpiresAt))
    hasAutoRefreshFailedRef.current = false
  }, [initialRealtimeToken, initialRealtimeTokenExpiresAt])

  useEffect(() => {
    hasAutoRefreshFailedRef.current = false
    refreshRetryAttemptRef.current = 0
    lastRefreshErrorRef.current = null
    if (refreshRetryTimerRef.current) {
      clearTimeout(refreshRetryTimerRef.current)
      refreshRetryTimerRef.current = null
    }
  }, [customerId, projectId])

  useEffect(() => {
    if (!isEventsStreamEnabled) {
      setEventStreamPausedAt(null)
    }
  }, [isEventsStreamEnabled])

  useEffect(() => {
    onConnectionStateChange?.({
      status: socketStatus,
      attempts: refreshRetryAttemptRef.current,
      lastError: lastRefreshErrorRef.current,
    })
  }, [onConnectionStateChange, socketStatus])

  const rejectPendingVerifyRequests = useCallback((message: string) => {
    if (pendingVerifyRequestsRef.current.size === 0) {
      return
    }

    const error = new Error(message)
    for (const [requestId, pending] of pendingVerifyRequestsRef.current.entries()) {
      clearTimeout(pending.timeoutId)
      pending.reject(error)
      pendingVerifyRequestsRef.current.delete(requestId)
    }
  }, [])

  useEffect(() => {
    setSubscription(null)
    setSubscriptionStatus(null)
    setMetrics(null)
    setEntitlements([])
    setFeatures([])
    setUsageByFeature({})
    setEvents([])
    setAlerts([])
    setEventStreamPausedAt(null)
    setValidationsByFeature({})
    setLastValidationEvent(null)
    rejectPendingVerifyRequests("Realtime context changed")
  }, [customerId, projectId, rejectPendingVerifyRequests])

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
      if (refreshRetryTimerRef.current) {
        clearTimeout(refreshRetryTimerRef.current)
        refreshRetryTimerRef.current = null
      }
      rejectPendingVerifyRequests("Realtime provider unmounted")
    }
  }, [rejectPendingVerifyRequests])

  const appendRealtimeEvent = useCallback(
    (event: EntitlementRealtimeEvent) => {
      setEvents((previous) => [event, ...previous].slice(0, maxEvents))
    },
    [maxEvents]
  )

  const appendAlertEvent = useCallback(
    (event: RealtimeAlertEvent) => {
      setAlerts((previous) => [event, ...previous].slice(0, maxEvents))
      onAlertEvent?.(event)
    },
    [maxEvents, onAlertEvent]
  )

  const appendValidationEvent = useCallback(
    (event: EntitlementValidationEvent) => {
      setValidationsByFeature((previous) => ({
        ...previous,
        [event.featureSlug]: event,
      }))
      setLastValidationEvent(event)
      onValidationEvent?.(event)
    },
    [onValidationEvent]
  )

  const requestSnapshot = useCallback(
    (params?: { force?: boolean; socket?: SocketSender | null }) => {
      const force = Boolean(params?.force)
      const socket = params?.socket ?? partySocketRef.current

      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return
      }

      if (!activeRealtimeTokenRef.current || isRealtimeTokenExpiredRef.current) {
        return
      }

      const now = Date.now()
      if (!force && now - lastSnapshotRequestedAtRef.current < SNAPSHOT_REQUEST_THROTTLE_MS) {
        return
      }

      lastSnapshotRequestedAtRef.current = now
      socket.send(
        buildRealtimeClientMessage("snapshot_request", {
          windowSeconds: snapshotWindowSeconds,
        })
      )
    },
    [snapshotWindowSeconds]
  )

  const scheduleTokenRefreshRetry = useCallback(() => {
    if (refreshRetryTimerRef.current) {
      return
    }

    refreshRetryAttemptRef.current += 1
    const exponentialBackoffMs = Math.min(
      MAX_TOKEN_REFRESH_RETRY_DELAY_MS,
      1000 * 2 ** Math.min(refreshRetryAttemptRef.current, 5)
    )
    const jitterMs = Math.floor(Math.random() * 750)
    const delayMs = exponentialBackoffMs + jitterMs

    refreshRetryTimerRef.current = setTimeout(() => {
      refreshRetryTimerRef.current = null
      hasAutoRefreshFailedRef.current = false
      setIsRealtimeTokenExpired(true)
    }, delayMs)
  }, [])

  const refreshRealtimeTokenInternal = useCallback(
    async (reason: RealtimeTicketReason = "manual") => {
      if (refreshPromiseRef.current) {
        return refreshPromiseRef.current
      }

      const task = (async () => {
        setIsRefreshingToken(true)
        try {
          lastRefreshReasonRef.current = reason

          const nextTokenPayload = await getRealtimeTicket({
            customerId,
            projectId,
            reason,
            currentExpiresAt: activeRealtimeTokenExpiresAt,
          })

          if (!nextTokenPayload.ticket || nextTokenPayload.ticket.trim().length === 0) {
            throw new Error("Realtime ticket is missing")
          }

          const nextExpiresAt = normalizeEpochSeconds(nextTokenPayload.expiresAt)
          if (isUnmountedRef.current) {
            return
          }

          if (!nextExpiresAt) {
            throw new Error("Realtime ticket expiration is missing")
          }

          hasAutoRefreshFailedRef.current = false
          refreshRetryAttemptRef.current = 0
          lastRefreshErrorRef.current = null
          if (refreshRetryTimerRef.current) {
            clearTimeout(refreshRetryTimerRef.current)
            refreshRetryTimerRef.current = null
          }
          setActiveRealtimeToken(nextTokenPayload.ticket)
          setActiveRealtimeTokenExpiresAt(nextExpiresAt)
          setIsRealtimeTokenExpired(nextExpiresAt <= Math.floor(Date.now() / 1000))
          setError(null)
          onRealtimeTokenRefresh?.({
            ticket: nextTokenPayload.ticket,
            expiresAt: nextExpiresAt,
          })
        } catch (refreshError) {
          hasAutoRefreshFailedRef.current = true
          if (isUnmountedRef.current) {
            return
          }
          const normalizedError = toError(refreshError, "Failed to refresh realtime token")
          lastRefreshErrorRef.current = normalizedError.message
          setError(normalizedError)
          scheduleTokenRefreshRetry()
        } finally {
          if (!isUnmountedRef.current) {
            setIsRefreshingToken(false)
          }
        }
      })()

      refreshPromiseRef.current = task.finally(() => {
        refreshPromiseRef.current = null
      })
      return refreshPromiseRef.current
    },
    [
      customerId,
      getRealtimeTicket,
      onRealtimeTokenRefresh,
      projectId,
      scheduleTokenRefreshRetry,
      activeRealtimeTokenExpiresAt,
    ]
  )

  const handleVerifyResult = useCallback(
    (params: {
      featureSlug: string
      result: VerifyEntitlementResult
      source: EventSource
    }) => {
      const now = Date.now()
      const { featureSlug, result, source } = params

      appendValidationEvent({
        at: now,
        featureSlug,
        allowed: result.allowed,
        deniedReason: result.deniedReason,
        usage: result.usage,
        limit: result.limit,
        message: result.message,
        source,
      })
      appendRealtimeEvent({
        at: now,
        type: "verify",
        featureSlug,
        success: result.allowed,
        deniedReason: result.deniedReason,
        usage: result.usage,
        limit: result.limit,
        latencyMs: result.latency,
        source,
      })

      if (typeof result.usage === "number") {
        const usage = result.usage
        setUsageByFeature((previous) => ({
          ...previous,
          [featureSlug]: usage,
        }))
      }
    },
    [appendRealtimeEvent, appendValidationEvent]
  )

  const handleSocketMessage = useCallback(
    (data: string) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }

      if (!parsed || typeof parsed !== "object") {
        return
      }

      const payload = parsed as Record<string, unknown>
      const type = readString(payload, "type")

      if (
        type === "snapshot" ||
        type === "snapshot_error" ||
        type === "verify_result" ||
        type === "verify_error" ||
        type === "alert" ||
        type === "tail_expired" ||
        type === "tail_resumed" ||
        type === "tail_resume_error" ||
        type === "verify" ||
        type === "reportUsage"
      ) {
        setSocketStatus((current) => (current === "open" ? current : "open"))
      }

      if (type === "snapshot") {
        const state = readObject(payload, "state")
        let nextMetrics: RealtimeMetrics | null = null
        let nextUsageByFeature: Record<string, number> = {}

        if (state) {
          const snapshotCustomerId = readString(state, "customerId")
          const snapshotProjectId = readString(state, "projectId")
          if (snapshotCustomerId && snapshotCustomerId !== customerId) {
            return
          }
          if (snapshotProjectId && snapshotProjectId !== projectId) {
            return
          }

          const stateMetrics = state.metrics
          if (stateMetrics && typeof stateMetrics === "object") {
            nextMetrics = stateMetrics as RealtimeMetrics
          }

          const parsedEntitlements = readArray(state, "entitlements")
            .map((item) => parseRealtimeEntitlement(item))
            .filter((item): item is RealtimeEntitlement => item !== null)
          const parsedFeatures = readArray(state, "features")
            .map((item) => parseRealtimeFeature(item))
            .filter((item): item is RealtimeFeatureState => item !== null)
          const parsedSubscription = parseRealtimeSubscription(state.subscription)

          nextUsageByFeature = parseUsageByFeature(state.usageByFeature)

          setSubscription(parsedSubscription)
          setSubscriptionStatus(
            parsedSubscription?.status ?? parseSubscriptionStatus(state.subscriptionStatus)
          )
          setEntitlements(parsedEntitlements)
          setFeatures(parsedFeatures)
          setStateVersion(readString(state, "stateVersion") ?? null)
          setLastSnapshotAt(normalizeEpochMilliseconds(readNumber(state, "asOf")) ?? Date.now())
        }

        if (!nextMetrics) {
          const legacyMetrics = payload.metrics
          if (legacyMetrics && typeof legacyMetrics === "object") {
            nextMetrics = legacyMetrics as RealtimeMetrics
          }
        }

        if (nextMetrics) {
          setMetrics(nextMetrics)
        }

        if (Object.keys(nextUsageByFeature).length === 0) {
          nextUsageByFeature = parseUsageByFeature(payload.usageByFeature)
        }

        setUsageByFeature(() => nextUsageByFeature)
        return
      }

      if (type === "snapshot_error") {
        const code = readString(payload, "code")?.toLowerCase()
        const message = readString(payload, "message")
        if (
          code === "token_expired" ||
          message?.toLowerCase().includes("expired") ||
          message?.toLowerCase().includes("unauthorized")
        ) {
          setIsRealtimeTokenExpired(true)
        }
        return
      }

      if (type === "tail_expired") {
        if (!isEventsStreamEnabled) {
          return
        }
        setEventStreamPausedAt(readNumber(payload, "timestamp") ?? Date.now())
        return
      }

      if (type === "tail_resumed") {
        setEventStreamPausedAt(null)
        return
      }

      if (type === "tail_resume_error") {
        const message = readString(payload, "message") ?? "Failed to resume live event stream"
        setError(new Error(message))
        return
      }

      if (type === "alert") {
        if (!isAlertsStreamEnabled) {
          return
        }

        const payloadCustomerId = readString(payload, "customerId")
        if (payloadCustomerId && payloadCustomerId !== customerId) {
          return
        }

        const featureSlug = readString(payload, "featureSlug")
        const alertTypeRaw = readString(payload, "alertType")
        const alertType =
          alertTypeRaw === "limit_reached" || alertTypeRaw === "limit_recovered"
            ? alertTypeRaw
            : null

        if (!featureSlug || !alertType) {
          return
        }

        appendAlertEvent({
          at: readNumber(payload, "timestamp") ?? Date.now(),
          featureSlug,
          alertType,
          usage: normalizeUsageValue(readNumber(payload, "usage")),
          limit: normalizeLimitValue(readNumber(payload, "limit")),
          source: "socket",
        })
        return
      }

      if (type === "verify_result" || type === "verify_error") {
        const requestId = readString(payload, "requestId")
        if (!requestId) {
          return
        }

        const pending = pendingVerifyRequestsRef.current.get(requestId)
        if (!pending) {
          return
        }

        clearTimeout(pending.timeoutId)
        pendingVerifyRequestsRef.current.delete(requestId)

        if (type === "verify_error") {
          const message = readString(payload, "message") ?? "Verification failed"
          pending.reject(new Error(message))
          return
        }

        const rawResult = payload.result
        if (!rawResult || typeof rawResult !== "object") {
          pending.reject(new Error("Invalid verification response payload"))
          return
        }

        const result = rawResult as VerifyEntitlementResult
        if (typeof result.allowed !== "boolean") {
          pending.reject(new Error("Invalid verification response"))
          return
        }

        pending.resolve(result)
        return
      }

      if (type !== "verify" && type !== "reportUsage") {
        return
      }

      if (!isEventsStreamEnabled) {
        return
      }

      const payloadCustomerId = readString(payload, "customerId")
      if (payloadCustomerId && payloadCustomerId !== customerId) {
        return
      }

      const featureSlug = readString(payload, "featureSlug")
      const success = readBoolean(payload, "success")
      if (!featureSlug || typeof success !== "boolean") {
        return
      }

      const usage = readNumber(payload, "usage")
      const limit = readNumber(payload, "limit")
      const deniedReason = readString(payload, "deniedReason") as
        | VerifyEntitlementResult["deniedReason"]
        | undefined
      const latencyMs = readNumber(payload, "latencyMs")
      const now = Date.now()

      appendRealtimeEvent({
        at: now,
        type,
        featureSlug,
        success,
        usage,
        limit,
        deniedReason,
        latencyMs,
        source: "socket",
      })

      if (typeof usage === "number") {
        setUsageByFeature((previous) => ({
          ...previous,
          [featureSlug]: usage,
        }))
      }

      if (type === "verify") {
        appendValidationEvent({
          at: now,
          featureSlug,
          allowed: success,
          deniedReason,
          usage,
          limit,
          source: "socket",
        })
      }

      requestSnapshot()
    },
    [
      appendAlertEvent,
      appendRealtimeEvent,
      appendValidationEvent,
      customerId,
      isAlertsStreamEnabled,
      isEventsStreamEnabled,
      requestSnapshot,
    ]
  )

  const validateEntitlement = useCallback(
    async (input: VerifyEntitlementInput) => {
      const resolvedCustomerId = input.customerId ?? customerId

      if (!resolvedCustomerId) {
        throw new Error("customerId is required to validate entitlements")
      }

      if (resolvedCustomerId !== customerId) {
        throw new Error("validateEntitlement customerId must match the provider customerId")
      }

      if (disableWebsocket) {
        throw new Error("Websocket verification is disabled")
      }

      if (!partySocketRef.current || partySocketRef.current.readyState !== WebSocket.OPEN) {
        if (isRealtimeTokenExpiredRef.current) {
          await refreshRealtimeTokenInternal("expired")
        }
      }

      const socket = partySocketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Realtime websocket is not connected")
      }

      const requestId = createVerifyRequestId()
      const payload = {
        requestId,
        featureSlug: input.featureSlug,
        usage: input.usage,
        action: input.action,
        metadata: input.metadata,
      }

      const result = await new Promise<VerifyEntitlementResult>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingVerifyRequestsRef.current.delete(requestId)
          reject(new Error("Realtime verification timed out"))
        }, VERIFY_REQUEST_TIMEOUT_MS)

        pendingVerifyRequestsRef.current.set(requestId, {
          resolve,
          reject,
          timeoutId,
        })

        try {
          socket.send(buildRealtimeClientMessage("verify_request", payload))
        } catch (sendError) {
          clearTimeout(timeoutId)
          pendingVerifyRequestsRef.current.delete(requestId)
          reject(toError(sendError, "Failed to send realtime verification request"))
        }
      })

      handleVerifyResult({
        featureSlug: input.featureSlug,
        result,
        source: "hook",
      })

      setError(null)
      requestSnapshot({ force: true, socket })
      return result
    },
    [
      customerId,
      disableWebsocket,
      handleVerifyResult,
      projectId,
      refreshRealtimeTokenInternal,
      requestSnapshot,
    ]
  )

  useEffect(() => {
    if (!activeRealtimeToken || !activeRealtimeTokenExpiresAt) {
      setIsRealtimeTokenExpired(true)
      return
    }

    const now = Math.floor(Date.now() / 1000)
    if (activeRealtimeTokenExpiresAt <= now) {
      setIsRealtimeTokenExpired(true)
      return
    }

    setIsRealtimeTokenExpired(false)

    const expiresInMs = Math.max(0, activeRealtimeTokenExpiresAt * 1000 - Date.now())
    const expiryTimer = setTimeout(() => {
      setIsRealtimeTokenExpired(true)
    }, expiresInMs)

    const refreshInMs = Math.max(
      0,
      activeRealtimeTokenExpiresAt * 1000 - Date.now() - refreshLeadSeconds * 1000
    )

    const refreshTimer =
      refreshInMs > 0
        ? setTimeout(() => {
            void refreshRealtimeTokenInternal("pre_expiry")
          }, refreshInMs)
        : null

    return () => {
      clearTimeout(expiryTimer)
      if (refreshTimer) {
        clearTimeout(refreshTimer)
      }
    }
  }, [
    activeRealtimeToken,
    activeRealtimeTokenExpiresAt,
    refreshLeadSeconds,
    refreshRealtimeTokenInternal,
  ])

  useEffect(() => {
    if (disableWebsocket) {
      return
    }

    if (hasAutoRefreshFailedRef.current) {
      return
    }

    if (activeRealtimeToken && !isRealtimeTokenExpired) {
      return
    }

    void refreshRealtimeTokenInternal(activeRealtimeToken ? "expired" : "init")
  }, [activeRealtimeToken, disableWebsocket, isRealtimeTokenExpired, refreshRealtimeTokenInternal])

  const socket = usePartySocket({
    enabled: realtimeSocketEnabled,
    host: socketHost,
    room: roomName,
    prefix: "broadcast",
    party: "usagelimit",
    query: {
      ticket: activeRealtimeToken ?? "",
      tail: isEventsStreamEnabled ? "1" : "0",
      alerts: isAlertsStreamEnabled ? "1" : "0",
    },
    onOpen: (event) => {
      if (isRealtimeTokenExpiredRef.current) {
        return
      }
      setEventStreamPausedAt(null)
      setSocketStatus("open")
      requestSnapshot({
        force: true,
        socket: event.currentTarget as unknown as SocketSender | null,
      })
    },
    onMessage: (event) => {
      handleSocketMessage(event.data as string)
    },
    onClose: (event) => {
      setSocketStatus("closed")
      const reason = event.reason?.toLowerCase()
      if (
        reason.includes("expired") ||
        reason.includes("unauthorized") ||
        event.code === 4001 ||
        event.code === 4401 ||
        event.code === 1008
      ) {
        setIsRealtimeTokenExpired(true)
        if (!disableWebsocket && !hasAutoRefreshFailedRef.current) {
          void refreshRealtimeTokenInternal("reconnect")
        }
      }
      rejectPendingVerifyRequests("Realtime websocket disconnected")
    },
    onError: () => {
      setSocketStatus("error")
    },
  })

  useEffect(() => {
    if (!realtimeSocketEnabled) {
      partySocketRef.current = null
      setSocketStatus("idle")
      rejectPendingVerifyRequests("Realtime websocket disabled")
      return
    }

    partySocketRef.current = socket as unknown as SocketSender
    setSocketStatus((currentStatus) => (currentStatus === "open" ? currentStatus : "connecting"))
    requestSnapshot({
      force: true,
      socket: socket as unknown as SocketSender,
    })
  }, [realtimeSocketEnabled, rejectPendingVerifyRequests, requestSnapshot, socket])

  useEffect(() => {
    if (!realtimeSocketEnabled || socketStatus !== "open") {
      return
    }

    const retryIntervalMs = Math.max(1_000, Math.floor(snapshotRetryIntervalMs))
    const thresholdMs = Math.max(5_000, Math.floor(snapshotStaleThresholdMs))

    const intervalId = setInterval(() => {
      const ageMs =
        typeof lastSnapshotAt === "number" ? Date.now() - lastSnapshotAt : Number.POSITIVE_INFINITY

      if (ageMs >= thresholdMs) {
        requestSnapshot({ force: true })
      }
    }, retryIntervalMs)

    return () => {
      clearInterval(intervalId)
    }
  }, [
    lastSnapshotAt,
    realtimeSocketEnabled,
    requestSnapshot,
    snapshotRetryIntervalMs,
    snapshotStaleThresholdMs,
    socketStatus,
  ])

  const entitlementSlugs = useMemo(() => {
    return new Set(entitlements.map((entitlement) => entitlement.featureSlug))
  }, [entitlements])

  const entitlementByFeatureSlug = useMemo(() => {
    const map = new Map<string, RealtimeEntitlement>()
    for (const entitlement of entitlements) {
      map.set(entitlement.featureSlug, entitlement)
    }
    return map
  }, [entitlements])

  const refreshSnapshot = useCallback(() => {
    requestSnapshot({ force: true })
  }, [requestSnapshot])

  const resumeEventStream = useCallback(() => {
    if (!isEventsStreamEnabled) {
      return
    }

    const socket = partySocketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return
    }

    setEventStreamPausedAt(null)
    socket.send(buildRealtimeClientMessage("resume_tail", {}))
  }, [isEventsStreamEnabled])

  const value = useMemo<EntitlementsRealtimeContextValue>(
    () => ({
      customerId,
      projectId,
      subscriptionStatus,
      subscription,
      entitlements,
      entitlementSlugs,
      entitlementByFeatureSlug,
      features,
      usageByFeature,
      metrics,
      lastSnapshotAt,
      stateVersion,
      events,
      alerts,
      validationsByFeature,
      lastValidationEvent,
      socketStatus,
      eventStreamState: eventStreamPausedAt === null ? "active" : "paused",
      eventStreamPausedAt,
      isConnected: socketStatus === "open",
      isRefreshingToken,
      error,
      refreshRealtimeToken: () => refreshRealtimeTokenInternal("manual"),
      refreshSnapshot,
      resumeEventStream,
      validateEntitlement,
    }),
    [
      customerId,
      projectId,
      subscriptionStatus,
      subscription,
      entitlements,
      entitlementSlugs,
      entitlementByFeatureSlug,
      features,
      usageByFeature,
      metrics,
      lastSnapshotAt,
      stateVersion,
      alerts,
      error,
      eventStreamPausedAt,
      events,
      isRefreshingToken,
      lastValidationEvent,
      refreshSnapshot,
      refreshRealtimeTokenInternal,
      resumeEventStream,
      socketStatus,
      validateEntitlement,
      validationsByFeature,
    ]
  )

  return (
    <EntitlementsRealtimeContext.Provider value={value}>
      {children}
    </EntitlementsRealtimeContext.Provider>
  )
}

function useEntitlementsRealtimeContext() {
  const context = useContext(EntitlementsRealtimeContext)
  if (!context) {
    throw new Error(
      "useEntitlementsRealtimeContext must be used inside UnpriceEntitlementsRealtimeProvider"
    )
  }
  return context
}

export function useUnpriceEntitlementsRealtime() {
  return useEntitlementsRealtimeContext()
}

export function useUnpriceUsage(options: UseUnpriceUsageOptions = {}): UseUnpriceUsageResult {
  const { featureSlugs = [], seedRows = [], scope = "entitlements" } = options
  const { entitlements, features, usageByFeature } = useEntitlementsRealtimeContext()

  return useMemo(() => {
    const seedByFeatureSlug = new Map<string, UnpriceUsageSeedRow>()
    for (const seedRow of seedRows) {
      const featureSlug = seedRow.featureSlug.trim()
      if (!featureSlug || seedByFeatureSlug.has(featureSlug)) {
        continue
      }
      seedByFeatureSlug.set(featureSlug, seedRow)
    }

    const featureByFeatureSlug = new Map<string, RealtimeFeatureState>()
    for (const feature of features) {
      featureByFeatureSlug.set(feature.featureSlug, feature)
    }

    const uniqueSlugs = new Set<string>()
    const includeAllFeatures = scope === "all" || entitlements.length === 0

    for (const featureSlug of featureSlugs) {
      const normalized = featureSlug.trim()
      if (normalized) {
        uniqueSlugs.add(normalized)
      }
    }
    for (const entitlement of entitlements) {
      uniqueSlugs.add(entitlement.featureSlug)
    }
    if (includeAllFeatures) {
      for (const feature of features) {
        uniqueSlugs.add(feature.featureSlug)
      }
      for (const featureSlug of Object.keys(usageByFeature)) {
        uniqueSlugs.add(featureSlug)
      }
    }
    for (const featureSlug of seedByFeatureSlug.keys()) {
      uniqueSlugs.add(featureSlug)
    }

    const rows: UnpriceUsageRow[] = []
    let totalUsage = 0
    let meteredFeatureCount = 0
    let featuresAtOrOverLimit = 0

    for (const featureSlug of uniqueSlugs) {
      const feature = featureByFeatureSlug.get(featureSlug)
      const seedRow = seedByFeatureSlug.get(featureSlug)

      const featureType = normalizeFeatureType(feature?.featureType ?? seedRow?.featureType ?? null)
      const usage =
        normalizeUsageValue(usageByFeature[featureSlug]) ??
        normalizeUsageValue(feature?.usage) ??
        normalizeUsageValue(seedRow?.usage) ??
        null
      const limit =
        normalizeLimitValue(feature?.limit) ?? normalizeLimitValue(seedRow?.limit) ?? null
      const hasLimit = limit !== null
      const limitType = normalizeLimitType(feature?.limitType ?? seedRow?.limitType, hasLimit)
      const isFlatFeature = featureType === "flat"
      const allowsOverage = limitType !== "hard"

      if (typeof usage === "number" && usage > 0) {
        totalUsage += usage
      }

      if (!isFlatFeature) {
        meteredFeatureCount += 1
      }

      if (hasLimit && typeof usage === "number" && usage >= limit) {
        featuresAtOrOverLimit += 1
      }

      rows.push({
        featureSlug,
        usage,
        limit,
        limitType,
        featureType,
        hasLimit,
        isFlatFeature,
        allowsOverage,
      })
    }

    rows.sort((a, b) => a.featureSlug.localeCompare(b.featureSlug))
    const byFeatureSlug = new Map<string, UnpriceUsageRow>()
    for (const row of rows) {
      byFeatureSlug.set(row.featureSlug, row)
    }

    return {
      rows,
      byFeatureSlug,
      totalUsage,
      meteredFeatureCount,
      featuresAtOrOverLimit,
    }
  }, [entitlements, featureSlugs, features, scope, seedRows, usageByFeature])
}

export function useValidateEntitlement() {
  const { validateEntitlement, lastValidationEvent } = useEntitlementsRealtimeContext()
  const [pendingCount, setPendingCount] = useState(0)
  const [error, setError] = useState<Error | null>(null)

  const validate = useCallback(
    async (input: VerifyEntitlementInput) => {
      setPendingCount((count) => count + 1)
      setError(null)
      try {
        return await validateEntitlement(input)
      } catch (validationError) {
        const normalizedError = toError(validationError, "Failed to validate entitlement")
        setError(normalizedError)
        throw normalizedError
      } finally {
        setPendingCount((count) => Math.max(0, count - 1))
      }
    },
    [validateEntitlement]
  )

  return {
    validate,
    isValidating: pendingCount > 0,
    error,
    lastValidationEvent,
  }
}

export function useEntitlement(featureSlug: string): UseEntitlementResult {
  const {
    entitlementByFeatureSlug,
    entitlementSlugs,
    usageByFeature,
    validationsByFeature,
    validateEntitlement,
  } = useEntitlementsRealtimeContext()

  const validate = useCallback(
    async (input: Omit<VerifyEntitlementInput, "featureSlug"> = {}) => {
      return await validateEntitlement({
        ...input,
        featureSlug,
      })
    },
    [featureSlug, validateEntitlement]
  )

  const entitlement = entitlementByFeatureSlug.get(featureSlug) ?? null
  const usage = typeof usageByFeature[featureSlug] === "number" ? usageByFeature[featureSlug] : null
  const lastValidation = validationsByFeature[featureSlug] ?? null
  const isEntitled = entitlementSlugs.has(featureSlug)
  const isAllowed = lastValidation?.allowed ?? isEntitled

  return useMemo(
    () => ({
      featureSlug,
      entitlement,
      isEntitled,
      isAllowed,
      shouldRenderPaywall: !isAllowed,
      usage,
      lastValidation,
      validate,
    }),
    [entitlement, featureSlug, isAllowed, isEntitled, lastValidation, usage, validate]
  )
}

export function EntitlementRealtimeFeature(props: {
  featureSlug: string
  children: (value: UseEntitlementResult) => ReactNode
}) {
  const value = useEntitlement(props.featureSlug)
  return <>{props.children(value)}</>
}

export function EntitlementValidationListener(props: {
  onValidation: (event: EntitlementValidationEvent) => void
  onlyDenied?: boolean
}) {
  const { onValidation, onlyDenied = false } = props
  const { lastValidationEvent } = useEntitlementsRealtimeContext()
  const lastNotifiedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!lastValidationEvent) {
      return
    }

    if (onlyDenied && lastValidationEvent.allowed) {
      return
    }

    const key = `${lastValidationEvent.featureSlug}:${lastValidationEvent.at}:${lastValidationEvent.source}`
    if (lastNotifiedRef.current === key) {
      return
    }

    lastNotifiedRef.current = key
    onValidation(lastValidationEvent)
  }, [lastValidationEvent, onValidation, onlyDenied])

  return null
}
