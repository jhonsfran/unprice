import type { MeterConfig, OverageStrategy } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { vi } from "vitest"
import type { CustomerService } from "../../customers"
import {
  type GrantsManager,
  type IngestionResolvedState,
  type ResolvedFeatureStateAtTimestamp,
  deriveMeterKey,
} from "../../entitlements"
import { IngestionQueueConsumer } from "../consumer"
import type { IngestionQueueMessage } from "../message"
import { IngestionService } from "../service"

type LoggerStub = {
  flush: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
}

type BeginResult =
  | {
      decision: "busy"
      retryAfterSeconds?: number
    }
  | {
      decision: "duplicate"
    }
  | {
      decision: "process"
    }

type ApplyInput = {
  customerId: string
  enforceLimit: boolean
  event: {
    id: string
    properties: Record<string, unknown>
    slug: string
    timestamp: number
  }
  featureSlug: string
  idempotencyKey: string
  limit?: number | null
  meters: MeterConfig[]
  now: number
  overageStrategy?: OverageStrategy
  periodEndAt: number
  periodKey: string
  projectId: string
  streamId: string
}

type ApplyResult = {
  allowed: boolean
  deniedReason?: "LIMIT_EXCEEDED"
  message?: string
}

type EnforcementInput = {
  limit?: number | null
  meterConfig: MeterConfig
  overageStrategy?: OverageStrategy | null
}

type EnforcementResult = {
  isLimitReached: boolean
  limit: number | null
  usage: number
}

type HarnessOptions = {
  beginResult?: BeginResult
  customer?: {
    projectId: string
  } | null
  getEnforcementState?: ReturnType<
    typeof vi.fn<(input: EnforcementInput) => Promise<EnforcementResult>>
  >
  grants?: unknown[]
  apply?: ReturnType<typeof vi.fn<(input: ApplyInput) => Promise<ApplyResult>>>
  resolveFeatureStateError?: Error
  resolveIngestionStatesError?: Error
  resolvedFeatureState?: ResolvedFeatureStateAtTimestamp
  resolvedFeatureStatesBySlug?: Record<string, ResolvedFeatureStateAtTimestamp>
  resolvedStates?: IngestionResolvedState[]
  send?: ReturnType<typeof vi.fn>
}

type MeterState = {
  updatedAt: number
  value: number
}

type MeterWindow = Map<string, MeterState>

export function createServiceHarness(options: HarnessOptions = {}) {
  const meterWindowsByKey = new Map<string, MeterWindow>()
  const logger = createLoggerStub()
  const send = options.send ?? vi.fn().mockResolvedValue(undefined)
  const apply = vi.fn<(input: ApplyInput) => Promise<ApplyResult>>()
  const getEnforcementState = vi.fn<(input: EnforcementInput) => Promise<EnforcementResult>>()

  const getCustomer = vi
    .fn()
    .mockResolvedValue(
      Ok((options.customer === undefined ? { projectId: "proj_123" } : options.customer) as never)
    )
  const getGrantsForCustomer = vi.fn().mockResolvedValue(
    Ok({
      grants: options.grants ?? [],
    } as never)
  )
  const resolveIngestionStatesFromGrants = vi.fn().mockImplementation(async () => {
    if (options.resolveIngestionStatesError) {
      return Err(options.resolveIngestionStatesError as never)
    }

    return Ok((options.resolvedStates ?? []) as never)
  })
  const resolveFeatureStateAtTimestamp = vi.fn().mockImplementation(async (params) => {
    if (options.resolveFeatureStateError) {
      return Err(options.resolveFeatureStateError as never)
    }

    const fromMap = options.resolvedFeatureStatesBySlug?.[params.featureSlug]
    if (fromMap) {
      return Ok(fromMap as never)
    }

    if (options.resolvedFeatureState) {
      return Ok(options.resolvedFeatureState as never)
    }

    const matchingResolvedState = (options.resolvedStates ?? []).find(
      (state) => state.featureSlug === params.featureSlug
    )

    if (matchingResolvedState) {
      return Ok(createUsageFeatureState(matchingResolvedState) as never)
    }

    return Ok({
      kind: "feature_missing",
    } as never)
  })

  const begin = vi.fn().mockResolvedValue(options.beginResult ?? { decision: "process" as const })
  const complete = vi.fn().mockResolvedValue(undefined)
  const abort = vi.fn().mockResolvedValue(undefined)
  const getIdempotencyStub = vi.fn().mockReturnValue({
    begin,
    complete,
    abort,
  })

  const getEntitlementWindowStub = vi.fn().mockImplementation((params) => {
    const windowKey = buildMeterWindowKey(params)

    return {
      apply: async (input: ApplyInput) => {
        apply(input)

        if (options.apply) {
          return options.apply(input)
        }

        return applyToWindow({
          window: getOrCreateMeterWindow(meterWindowsByKey, windowKey),
          input,
        })
      },
      getEnforcementState: async (input: EnforcementInput) => {
        getEnforcementState(input)

        if (options.getEnforcementState) {
          return options.getEnforcementState(input)
        }

        const meterWindow = meterWindowsByKey.get(windowKey)
        const meterState = meterWindow?.get(deriveMeterKey(input.meterConfig))
        const usage = Number(meterState?.value ?? 0)
        const limit = normalizeLimit(input.limit)
        const isLimitReached =
          typeof limit === "number" &&
          Number.isFinite(limit) &&
          input.overageStrategy !== "always" &&
          usage >= limit

        return {
          isLimitReached,
          limit,
          usage,
        }
      },
    }
  })

  const service = new IngestionService({
    customerService: {
      getCustomer,
    } as unknown as CustomerService,
    entitlementWindowClient: {
      getEntitlementWindowStub,
    },
    grantsManager: {
      getGrantsForCustomer,
      resolveFeatureStateAtTimestamp,
      resolveIngestionStatesFromGrants,
    } as unknown as GrantsManager,
    idempotencyClient: {
      getIdempotencyStub,
    },
    logger,
    pipelineEvents: {
      send,
    },
  })

  const consumer = new IngestionQueueConsumer({
    logger,
    processor: service,
  })

  return {
    consumer,
    service,
    mocks: {
      abort,
      apply,
      begin,
      complete,
      getCustomer,
      getEnforcementState,
      getEntitlementWindowStub,
      getGrantsForCustomer,
      getIdempotencyStub,
      logger,
      meterWindowsByKey,
      resolveFeatureStateAtTimestamp,
      resolveIngestionStatesFromGrants,
      send,
    },
  }
}

function applyToWindow(params: {
  input: ApplyInput
  window: MeterWindow
}): ApplyResult {
  const { input, window } = params
  const pendingUpdates: Array<{
    delta: number
    meterKey: string
    nextValue: number
    updatedAt: number
  }> = []

  for (const meter of input.meters) {
    const meterKey = deriveMeterKey(meter)
    const previous = window.get(meterKey) ?? {
      updatedAt: Number.NEGATIVE_INFINITY,
      value: 0,
    }
    const nextValue = computeNextMeterValue({
      eventTimestamp: input.event.timestamp,
      meter,
      previous,
      properties: input.event.properties,
    })
    const delta = nextValue - previous.value
    const updatedAt =
      meter.aggregationMethod === "latest" && input.event.timestamp < previous.updatedAt
        ? previous.updatedAt
        : Math.max(previous.updatedAt, input.event.timestamp)

    pendingUpdates.push({
      meterKey,
      nextValue,
      delta,
      updatedAt,
    })
  }

  const limit = normalizeLimit(input.limit)
  const overageStrategy = input.overageStrategy ?? "none"

  if (input.enforceLimit && limit !== null && overageStrategy !== "always") {
    for (const update of pendingUpdates) {
      if (update.delta <= 0) {
        continue
      }

      if (overageStrategy === "last-call") {
        const previousValue = update.nextValue - update.delta
        if (previousValue >= limit) {
          return {
            allowed: false,
            deniedReason: "LIMIT_EXCEEDED",
            message: `Limit exceeded for meter ${update.meterKey}`,
          }
        }
        continue
      }

      if (update.nextValue > limit) {
        return {
          allowed: false,
          deniedReason: "LIMIT_EXCEEDED",
          message: `Limit exceeded for meter ${update.meterKey}`,
        }
      }
    }
  }

  for (const update of pendingUpdates) {
    window.set(update.meterKey, {
      value: update.nextValue,
      updatedAt: update.updatedAt,
    })
  }

  return {
    allowed: true,
  }
}

function computeNextMeterValue(params: {
  eventTimestamp: number
  meter: MeterConfig
  previous: MeterState
  properties: Record<string, unknown>
}): number {
  const { meter, previous } = params

  switch (meter.aggregationMethod) {
    case "count":
      return previous.value + 1
    case "sum": {
      const numericValue = readAggregationNumericValue(meter, params.properties)
      return previous.value + numericValue
    }
    case "max": {
      const numericValue = readAggregationNumericValue(meter, params.properties)
      return Number.isFinite(previous.value) ? Math.max(previous.value, numericValue) : numericValue
    }
    case "latest": {
      if (params.eventTimestamp < previous.updatedAt) {
        return previous.value
      }
      return readAggregationNumericValue(meter, params.properties)
    }
  }
}

function readAggregationNumericValue(
  meter: MeterConfig,
  properties: Record<string, unknown>
): number {
  const field = meter.aggregationField?.trim()

  if (!field) {
    throw new Error(`Meter ${meter.eventId} requires an aggregation field`)
  }

  const value = properties[field]

  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return value
    }
    throw new Error(`Meter ${meter.eventId} requires a finite numeric value at properties.${field}`)
  }

  if (typeof value === "string") {
    const parsedValue = Number(value.trim())
    if (Number.isFinite(parsedValue)) {
      return parsedValue
    }
  }

  throw new Error(`Meter ${meter.eventId} requires a finite numeric value at properties.${field}`)
}

function buildMeterWindowKey(params: {
  customerId: string
  periodKey: string
  projectId: string
  streamId: string
}): string {
  return `${params.projectId}:${params.customerId}:${params.streamId}:${params.periodKey}`
}

function getOrCreateMeterWindow(windows: Map<string, MeterWindow>, key: string): MeterWindow {
  const existing = windows.get(key)
  if (existing) {
    return existing
  }

  const next = new Map<string, MeterState>()
  windows.set(key, next)
  return next
}

function normalizeLimit(limit?: number | null): number | null {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return null
  }

  return limit
}

export function createUsageGrant(
  params: {
    featureSlug?: string
  } = {}
) {
  return {
    featurePlanVersion: {
      feature: {
        slug: params.featureSlug ?? "api_calls",
      },
      featureType: "usage",
      meterConfig: {
        eventId: `meter_${params.featureSlug ?? "api_calls"}`,
      },
    },
  }
}

export function createBooleanGrant(
  params: {
    featureSlug?: string
  } = {}
) {
  return {
    featurePlanVersion: {
      feature: {
        slug: params.featureSlug ?? "team_members",
      },
      featureType: "flat",
      meterConfig: null,
    },
  }
}

export function createResolvedState(
  timestamp = Date.UTC(2026, 2, 19, 12, 0, 0),
  overrides: Partial<IngestionResolvedState> = {}
): IngestionResolvedState {
  const defaults: IngestionResolvedState = {
    activeGrantIds: ["grant_123"],
    customerId: "cus_123",
    featureSlug: "api_calls",
    limit: 100,
    meterConfig: {
      eventId: "meter_123",
      eventSlug: "tokens_used",
      aggregationMethod: "sum",
      aggregationField: "amount",
    },
    overageStrategy: "none",
    projectId: "proj_123",
    resetConfig: null,
    streamEndAt: null,
    streamId: "stream_123",
    streamStartAt: timestamp,
  }

  return {
    ...defaults,
    ...overrides,
    meterConfig: overrides.meterConfig ?? defaults.meterConfig,
    resetConfig: overrides.resetConfig ?? defaults.resetConfig,
  }
}

export function createUsageFeatureState(
  state = createResolvedState()
): ResolvedFeatureStateAtTimestamp {
  return {
    kind: "usage",
    state,
  }
}

export function mapFeatureStatesBySlug(
  states: IngestionResolvedState[]
): Record<string, ResolvedFeatureStateAtTimestamp> {
  return Object.fromEntries(
    states.map((state) => [state.featureSlug, createUsageFeatureState(state)])
  )
}

export function createBatchMessage(overrides: Partial<IngestionQueueMessage> = {}): {
  ack: ReturnType<typeof vi.fn>
  message: {
    body: IngestionQueueMessage
    ack: ReturnType<typeof vi.fn>
    retry: ReturnType<typeof vi.fn>
  }
  retry: ReturnType<typeof vi.fn>
} {
  const ack = vi.fn()
  const retry = vi.fn()

  return {
    ack,
    retry,
    message: {
      ack,
      retry,
      body: {
        version: 1,
        projectId: "proj_123",
        customerId: "cus_123",
        requestId: "req_123",
        receivedAt: Date.UTC(2026, 2, 19, 12, 0, 0),
        idempotencyKey: "idem_123",
        id: "evt_123",
        slug: "tokens_used",
        timestamp: Date.UTC(2026, 2, 19, 12, 0, 0),
        properties: {
          amount: 1,
        },
        ...overrides,
      },
    },
  }
}

export function createRawBatchMessage(body: unknown): {
  ack: ReturnType<typeof vi.fn>
  message: {
    body: unknown
    ack: ReturnType<typeof vi.fn>
    retry: ReturnType<typeof vi.fn>
  }
  retry: ReturnType<typeof vi.fn>
} {
  const ack = vi.fn()
  const retry = vi.fn()

  return {
    ack,
    retry,
    message: {
      ack,
      retry,
      body,
    },
  }
}

function createLoggerStub(): Logger & LoggerStub {
  return {
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
    set: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger & LoggerStub
}
