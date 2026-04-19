import type { ConfigFeatureVersionType, MeterConfig, OverageStrategy } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { vi } from "vitest"
import type { Cache } from "../../cache/service"
import {
  type GrantsManager,
  type IngestionResolvedState,
  type ResolvedFeatureStateAtTimestamp,
  UnPriceGrantError,
  deriveMeterKey,
} from "../../entitlements"
import type { IngestionAuditCommitResult, IngestionAuditEntry } from "../audit"
import { IngestionQueueConsumer } from "../consumer"
import type { IngestionQueueMessage } from "../message"
import type { PreparedCustomerGrantContext } from "../service"
import { IngestionService } from "../service"

type LoggerStub = {
  flush: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
}

type ApplyInput = {
  customerId: string
  currency: string
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
  meter: MeterConfig
  priceConfig: ConfigFeatureVersionType
  now: number
  overageStrategy?: OverageStrategy
  periodEndAt: number
  periodKey: string
  projectId: string
  streamId: string
  featurePlanVersionId: string
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
  commitResult?: IngestionAuditCommitResult
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
  now?: () => number
}

type MeterState = {
  updatedAt: number
  value: number
}

type MeterWindow = Map<string, MeterState>

export function createServiceHarness(options: HarnessOptions = {}) {
  const meterWindowsByKey = new Map<string, MeterWindow>()
  const verificationGrantContextCache = new Map<string, PreparedCustomerGrantContext>()
  const verificationGrantContextLoads = new Map<
    string,
    Promise<{ err?: unknown; val?: PreparedCustomerGrantContext }>
  >()
  const logger = createLoggerStub()
  const commit = vi
    .fn<(entries: IngestionAuditEntry[]) => Promise<IngestionAuditCommitResult>>()
    .mockResolvedValue(options.commitResult ?? { inserted: 1, duplicates: 0, conflicts: 0 })
  const apply = vi.fn<(input: ApplyInput) => Promise<ApplyResult>>()
  const getEnforcementState = vi.fn<(input: EnforcementInput) => Promise<EnforcementResult>>()
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()

  const getGrantsForCustomer = vi.fn().mockResolvedValue(
    options.customer === null
      ? Err(
          new UnPriceGrantError({
            message: "No customer found for project",
            code: "CUSTOMER_NOT_FOUND",
            subjectId: "cust_missing",
          }) as never
        )
      : Ok({
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

  const exists = vi.fn<(idempotencyKeys: string[]) => Promise<string[]>>().mockResolvedValue([])
  const getAuditStub = vi.fn().mockReturnValue({
    commit,
    exists,
  })

  const cache = {
    ingestionPreparedGrantContext: {
      swr: async (key: string, loader: (key: string) => Promise<PreparedCustomerGrantContext>) => {
        if (verificationGrantContextCache.has(key)) {
          return {
            val: verificationGrantContextCache.get(key),
          }
        }

        const existingLoad = verificationGrantContextLoads.get(key)
        if (existingLoad) {
          return existingLoad
        }

        const nextLoad = loader(key)
          .then((value) => {
            verificationGrantContextCache.set(key, value)
            verificationGrantContextLoads.delete(key)

            return {
              val: value,
            }
          })
          .catch((error) => {
            verificationGrantContextLoads.delete(key)

            return {
              err: error,
            }
          })

        verificationGrantContextLoads.set(key, nextLoad)

        return nextLoad
      },
    },
  } as unknown as Pick<Cache, "ingestionPreparedGrantContext">

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
    cache,
    entitlementWindowClient: {
      getEntitlementWindowStub,
    },
    grantsManager: {
      getGrantsForCustomer,
      resolveFeatureStateAtTimestamp,
      resolveIngestionStatesFromGrants,
    } as unknown as GrantsManager,
    auditClient: {
      getAuditStub,
    },
    logger,
    now: options.now,
    waitUntil,
  })

  const consumer = new IngestionQueueConsumer({
    logger,
    processor: service,
  })

  return {
    consumer,
    service,
    mocks: {
      apply,
      commit,
      exists,
      getEnforcementState,
      getEntitlementWindowStub,
      getGrantsForCustomer,
      getAuditStub,
      logger,
      meterWindowsByKey,
      verificationGrantContextCache,
      resolveFeatureStateAtTimestamp,
      resolveIngestionStatesFromGrants,
      waitUntil,
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

  const meter = input.meter
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
    grantId?: string
    featurePlanVersionId?: string
    currency?: string
  } = {}
) {
  const featureSlug = params.featureSlug ?? "api_calls"
  const currency = params.currency ?? "USD"

  return {
    id: params.grantId ?? "grant_123",
    featurePlanVersionId: params.featurePlanVersionId ?? "fpv_123",
    featurePlanVersion: {
      feature: {
        slug: featureSlug,
      },
      featureType: "usage",
      meterConfig: {
        eventId: `meter_${featureSlug}`,
      },
      config: {
        usageMode: "unit",
        price: {
          dinero: {
            amount: 100,
            currency: {
              code: currency,
              base: 10,
              exponent: 2,
            },
            scale: 2,
          },
          displayAmount: "1.00",
        },
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
