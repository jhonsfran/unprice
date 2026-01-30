import type { AsyncLocalStorage as ALSType } from "node:async_hooks"
import type { WideEvent, WideEventAttributes, WideEventInput, WideEventKey } from "@unprice/logs"

// ============================================
// TYPES
// ============================================

/**
 * Primitive types that can be stored as flattened attribute values.
 */
type Primitive = string | number | boolean | null | undefined

/**
 * Function signature for emitting log events to an external system.
 *
 * @param level - The log level (debug, info, warn, error)
 * @param message - An optional message string (currently passed as empty string)
 * @param event - The complete wide event object containing all attributes
 * @returns void or a Promise for async emitters
 */
type EventEmitter = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  event: WideEvent
) => void | Promise<void>

/**
 * Configuration options for initializing the WideEventLogger.
 */
export interface WideEventConfig {
  /** The name of the service emitting events */
  "service.name": string
  /** The version of the service (e.g., "1.0.0") */
  "service.version": string
  /** The deployment environment */
  "service.environment": "production" | "staging" | "development" | "preview" | "test"
  /**
   * Sample rate for healthy traffic (0-1).
   * Errors and slow requests are always sampled regardless of this value.
   */
  sampleRate: number
  /** The emitter function that sends events to your logging backend */
  emitter: EventEmitter
}

/**
 * Internal context structure stored in AsyncLocalStorage.
 * Contains the accumulated attributes for the current request/operation.
 */
interface EventContext {
  /** Map of attribute key-value pairs accumulated during the request lifecycle */
  attributes: Map<string, unknown>
}

// ============================================
// STORAGE ADAPTER
// ============================================

/**
 * Creates a storage adapter that provides AsyncLocalStorage-like functionality.
 *
 * This adapter attempts to use Node.js AsyncLocalStorage for proper async context
 * propagation. If AsyncLocalStorage is unavailable (e.g., in edge runtimes or browsers),
 * it falls back to a simple variable-based storage.
 *
 * Note: The fallback does NOT provide true async context isolation and may cause
 * context leakage in concurrent scenarios. It's suitable only for single-request
 * environments like edge functions.
 *
 * @template T - The type of value to store in the context
 * @returns An object with getStore and run methods mimicking AsyncLocalStorage API
 */
function createStorageAdapter<T>(): {
  getStore: () => T | undefined
  run: <R>(store: T, fn: () => R) => R
} {
  let als: ALSType<T> | null = null
  let fallback: T | undefined

  try {
    const { AsyncLocalStorage } = require("node:async_hooks") as typeof import("node:async_hooks")
    als = new AsyncLocalStorage<T>()
  } catch {
    // Fallback for edge/browser environments where async_hooks is unavailable
  }

  return {
    /**
     * Retrieves the current store value from the active context.
     * @returns The current context value, or undefined if no context is active
     */
    getStore: () => als?.getStore() ?? fallback,

    /**
     * Executes a function within a new context with the provided store value.
     * @param store - The context value to make available during execution
     * @param fn - The function to execute within the context
     * @returns The return value of the executed function
     */
    run: <R>(store: T, fn: () => R): R => {
      if (als) return als.run(store, fn)
      // Fallback implementation: save previous value, set new, restore after
      const prev = fallback
      fallback = store
      try {
        return fn()
      } finally {
        fallback = prev
      }
    },
  }
}

// ============================================
// WIDE EVENT LOGGER
// ============================================

/**
 * WideEventLogger implements the "Wide Event" logging pattern, where a single
 * structured log event captures all relevant information about a request or
 * operation lifecycle.
 *
 * Key features:
 * - **Request-scoped instances**: Each request should create its own logger instance
 * - **Async context propagation**: Uses AsyncLocalStorage to maintain context
 *   across async boundaries without manual passing
 * - **Type-safe attributes**: Supports both typed keys from WideEventAttributes
 *   and arbitrary string keys for flexibility
 * - **Automatic flattening**: Nested objects are flattened to dot notation
 * - **Smart sampling**: Always captures errors and slow requests; samples healthy traffic
 *
 * @example
 * ```ts
 * // Create a new logger for each request (recommended)
 * const logger = createWideEventLogger({
 *   "service.name": "api",
 *   "service.version": "1.0.0",
 *   "service.environment": "production",
 *   sampleRate: 0.1,
 *   emitter: (level, message, event) => console.log(JSON.stringify(event)),
 * })
 *
 * // In your request handler
 * await logger.runAsync(async () => {
 *   logger.add("request.method", "GET")
 *   logger.add("request.path", "/api/users")
 *
 *   try {
 *     const result = await handleRequest()
 *     logger.add("request.status", 200)
 *   } catch (error) {
 *     logger.addError(error)
 *     logger.add("request.status", 500)
 *   } finally {
 *     logger.emit()
 *   }
 * })
 * ```
 */
export class WideEventLogger {
  /** Storage adapter for async context management */
  private readonly storage = createStorageAdapter<EventContext>()

  /** Configuration for this logger instance */
  private config: WideEventConfig

  /**
   * Creates a new WideEventLogger instance.
   * Prefer using createWideEventLogger() factory function.
   *
   * @param config - The configuration options for the logger
   */
  constructor(config: WideEventConfig) {
    this.config = config
  }

  // ============================================
  // CONTEXT
  // ============================================

  /**
   * Executes a synchronous function within a new logging context.
   *
   * A new context is created with the service attributes pre-populated.
   * All add() calls within fn (including nested async operations) will
   * add attributes to this context.
   *
   * @template T - The return type of the function
   * @param fn - The function to execute within the logging context
   * @returns The return value of the function
   *
   * @example
   * ```ts
   * const result = logger.run(() => {
   *   logger.add("user.id", "123")
   *   return processRequest()
   * })
   * ```
   */
  run<T>(fn: () => T): T {
    const ctx: EventContext = {
      attributes: new Map([
        ["service.name", this.config["service.name"]],
        ["service.version", this.config["service.version"]],
        ["service.environment", this.config["service.environment"]],
      ]),
    }
    return this.storage.run(ctx, fn)
  }

  /**
   * Executes an asynchronous function within a new logging context.
   *
   * This is a convenience wrapper around run() for async functions.
   * The context is maintained across all await points within the function.
   *
   * @template T - The resolved type of the Promise
   * @param fn - The async function to execute within the logging context
   * @returns A Promise resolving to the function's return value
   *
   * @example
   * ```ts
   * await logger.runAsync(async () => {
   *   logger.add("request.id", requestId)
   *   const data = await fetchData()
   *   logger.add("data.count", data.length)
   *   logger.emit()
   * })
   * ```
   */
  async runAsync<T>(fn: () => Promise<T>): Promise<T> {
    return this.run(() => fn())
  }

  /**
   * Checks if there is an active logging context.
   *
   * Useful for conditional logging or debugging context issues.
   *
   * @returns true if a context is active, false otherwise
   */
  hasContext(): boolean {
    return this.storage.getStore() !== undefined
  }

  // ============================================
  // ATTRIBUTES
  // ============================================

  /**
   * Adds a single attribute to the current logging context.
   *
   * This method is type-safe for known WideEventKey keys, ensuring correct
   * value types.
   *
   * If called outside of a context (no active run()), this is a no-op.
   * If the value is undefined, the attribute is not added.
   *
   * @param key - The attribute key (type-safe for WideEventKey)
   * @param value - The attribute value
   * @returns this for method chaining
   *
   * @example
   * ```ts
   * logger
   *   .add("request.method", "POST")
   *   .add("request.path", "/api/users")
   * ```
   */
  add<K extends WideEventKey>(key: K, value: WideEventAttributes[K]): this {
    const ctx = this.storage.getStore()
    if (!ctx || value === undefined) return this
    ctx.attributes.set(key, value)
    return this
  }

  /**
   * Adds multiple attributes at once, automatically flattening nested objects.
   *
   * Nested objects are converted to dot notation keys. Arrays are JSON stringified.
   * Undefined values are skipped.
   *
   * @param attrs - An object containing attributes to add
   * @returns this for method chaining
   *
   * @example
   * ```ts
   * logger.addMany({
   *   user: {
   *     id: "123",
   *     role: "admin"
   *   },
   *   request: {
   *     method: "GET"
   *   }
   * })
   * // Results in: user.id="123", user.role="admin", request.method="GET"
   * ```
   */
  addMany(attrs: WideEventInput): this {
    const ctx = this.storage.getStore()
    if (!ctx) return this

    for (const [k, v] of Object.entries(this.flatten(attrs as Record<string, unknown>))) {
      if (v !== undefined) ctx.attributes.set(k, v)
    }
    return this
  }

  /**
   * Adds error details to the current context in a standardized format.
   *
   * For Error instances, extracts name, message, and optionally stack trace.
   * Stack traces are only included in non-production environments to avoid
   * leaking implementation details.
   *
   * For non-Error values, converts to string and stores as error.message.
   *
   * @param error - The error to add (Error instance or any value)
   * @returns this for method chaining
   *
   * @example
   * ```ts
   * try {
   *   await riskyOperation()
   * } catch (error) {
   *   logger.addError(error)
   *   logger.add("request.status", 500)
   * }
   * ```
   */
  addError(error: unknown): this {
    if (error instanceof Error) {
      this.add("error.type", error.name)
      this.add("error.message", error.message)
      if (this.config["service.environment"] !== "production") {
        this.add("error.stack", error.stack)
      }
    } else if (error !== null && error !== undefined) {
      this.add("error.message", String(error))
    }
    return this
  }

  // ============================================
  // GETTERS
  // ============================================

  /**
   * Retrieves a single attribute value from the current context.
   *
   * Type-safe for known WideEventKey keys.
   *
   * @param key - The attribute key to retrieve
   * @returns The attribute value, or undefined if not set or no context
   *
   * @example
   * ```ts
   * const userId = logger.get("user.id")
   * const status = logger.get("request.status") as number
   * ```
   */
  get<K extends WideEventKey>(key: K): WideEventAttributes[K] | undefined
  get(key: string): unknown
  get(key: string): unknown {
    return this.storage.getStore()?.attributes.get(key)
  }

  /**
   * Retrieves all attributes from the current context as a plain object.
   *
   * @returns An object containing all attributes, or undefined if no context
   *
   * @example
   * ```ts
   * const allAttributes = logger.getAll()
   * console.log(JSON.stringify(allAttributes, null, 2))
   * ```
   */
  getAll(): Record<string, unknown> | undefined {
    const ctx = this.storage.getStore()
    return ctx ? Object.fromEntries(ctx.attributes) : undefined
  }

  // ============================================
  // EMIT
  // ============================================

  /**
   * Determines whether the current event should be sampled (emitted).
   *
   * Sampling strategy:
   * 1. **Always sample errors**: Any request with status >= 400
   * 2. **Always sample slow requests**: Any request taking > 1000ms
   * 3. **Sample healthy traffic**: Based on configured sampleRate (0-1)
   *
   * This ensures you never miss important events while controlling
   * log volume for normal operations.
   *
   * @returns true if the event should be emitted, false to skip
   */
  public shouldSample(): boolean {
    const status = (this.get("request.status") as number) || 200
    const duration = (this.get("request.duration") as number) || 0

    // 1. Always keep errors
    if (status >= 400) return true

    // 2. Always keep slow requests (> 1s)
    if (duration > 1000) return true

    // 3. Sample based on configured rate for healthy traffic
    return Math.random() < this.config.sampleRate
  }

  /**
   * Emits the accumulated wide event to the configured emitter.
   *
   * This should be called once at the end of a request/operation lifecycle,
   * typically in a finally block to ensure it's always called.
   *
   * The log level is determined by the request status:
   * - status >= 400 && status !== 429: "error"
   * - status === 429: "warn" (rate limiting is expected)
   * - status < 400: "info"
   *
   * If no context is active or sampling determines the event should be skipped,
   * nothing is emitted.
   *
   * Emitter errors are caught and logged to console only in non-production
   * environments to prevent logging failures from affecting the application.
   *
   * @example
   * ```ts
   * await logger.runAsync(async () => {
   *   try {
   *     // ... request handling
   *   } finally {
   *     logger.emit()
   *   }
   * })
   * ```
   */
  emit(): void {
    const ctx = this.storage.getStore()
    if (!ctx) return

    const event = {
      ...Object.fromEntries(ctx.attributes),
    } as WideEvent

    try {
      const shouldSample = this.shouldSample()
      if (shouldSample) {
        const status = (this.get("request.status") as number) || 200
        if (status >= 400) {
          if (status === 429) {
            // rate limited - warn level since this is often expected
            this.config.emitter("warn", "", event)
          } else {
            this.config.emitter("error", "", event)
          }
        } else {
          this.config.emitter("info", "", event)
        }
      }
    } catch (e) {
      if (this.config["service.environment"] !== "production") {
        console.error("[WideEvent] Emitter error:", e)
      }
    }
  }

  // ============================================
  // HELPERS
  // ============================================

  /**
   * Recursively flattens a nested object into dot-notation keys.
   *
   * @param obj - The object to flatten
   * @param prefix - The current key prefix (used in recursion)
   * @param result - The accumulator object (used in recursion)
   * @returns A flat object with dot-notation keys and primitive values
   *
   * @example
   * ```ts
   * flatten({ user: { id: "123", tags: ["a", "b"] } })
   * // Returns: { "user.id": "123", "user.tags": '["a","b"]' }
   * ```
   */
  private flatten(
    obj: Record<string, unknown>,
    prefix = "",
    result: Record<string, Primitive> = {}
  ): Record<string, Primitive> {
    for (const [key, value] of Object.entries(obj)) {
      const flatKey = prefix ? `${prefix}.${key}` : key

      if (value === null || value === undefined) {
        result[flatKey] = value
      } else if (Array.isArray(value)) {
        result[flatKey] = JSON.stringify(value)
      } else if (typeof value === "object") {
        this.flatten(value as Record<string, unknown>, flatKey, result)
      } else {
        result[flatKey] = value as Primitive
      }
    }
    return result
  }
}

// ============================================
// FACTORY FUNCTIONS
// ============================================

/**
 * Creates a new WideEventLogger instance.
 * This is the recommended way to create loggers for request-scoped usage.
 *
 * Each request should create its own logger instance to avoid
 * context leakage between concurrent requests.
 *
 * @param config - The configuration options for the logger
 * @returns A new WideEventLogger instance
 *
 * @example
 * ```ts
 * // In your middleware
 * const wideEventLogger = createWideEventLogger({
 *   "service.name": "api",
 *   "service.version": "1.0.0",
 *   "service.environment": "production",
 *   sampleRate: 0.1,
 *   emitter: (level, message, event) => logger.emit(level, message, event),
 * })
 *
 * // Pass through context
 * c.set("wideEventLogger", wideEventLogger)
 * ```
 */
export function createWideEventLogger(config: WideEventConfig): WideEventLogger {
  return new WideEventLogger(config)
}
