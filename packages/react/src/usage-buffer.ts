export type BufferedUsageEvent = {
  featureSlug: string
  usage?: number
  action?: string
  metadata?: Record<string, string | number | boolean>
  timestamp: number
}

export type UsageBufferDropPolicy = "drop_oldest" | "reject_newest"

export type UsageBufferConfig = {
  maxQueueSize?: number
  maxBatchSize?: number
  flushIntervalMs?: number
  dropPolicy?: UsageBufferDropPolicy
  coalesceWindowMs?: number
}

export type UsageBufferFlushResult = {
  accepted: number
  rejected: number
}

const DEFAULT_MAX_QUEUE_SIZE = 2_000
const DEFAULT_MAX_BATCH_SIZE = 100
const DEFAULT_FLUSH_INTERVAL_MS = 1_000
const DEFAULT_COALESCE_WINDOW_MS = 2_000

function normalizeUsage(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1
  }
  return value
}

function stableMetadataHash(metadata: BufferedUsageEvent["metadata"]): string {
  if (!metadata) return ""

  const keys = Object.keys(metadata).sort()
  const parts: string[] = []
  for (const key of keys) {
    parts.push(`${key}:${String(metadata[key])}`)
  }
  return parts.join("|")
}

function coalesceKey(event: BufferedUsageEvent, coalesceWindowMs: number): string {
  const bucket = Math.floor(event.timestamp / coalesceWindowMs)
  return `${event.featureSlug}|${event.action ?? ""}|${stableMetadataHash(event.metadata)}|${bucket}`
}

export class UsageBuffer {
  private readonly maxQueueSize: number
  private readonly maxBatchSize: number
  private readonly flushIntervalMs: number
  private readonly dropPolicy: UsageBufferDropPolicy
  private readonly coalesceWindowMs: number

  private queue: BufferedUsageEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private isFlushing = false

  constructor(config: UsageBufferConfig = {}) {
    const maxBatchSize =
      typeof config.maxBatchSize === "number" &&
      Number.isFinite(config.maxBatchSize) &&
      config.maxBatchSize >= 1
        ? Math.floor(config.maxBatchSize)
        : DEFAULT_MAX_BATCH_SIZE

    const flushIntervalMs =
      typeof config.flushIntervalMs === "number" &&
      Number.isFinite(config.flushIntervalMs) &&
      config.flushIntervalMs > 0
        ? config.flushIntervalMs
        : DEFAULT_FLUSH_INTERVAL_MS

    const coalesceWindowMs =
      typeof config.coalesceWindowMs === "number" &&
      Number.isFinite(config.coalesceWindowMs) &&
      config.coalesceWindowMs > 0
        ? config.coalesceWindowMs
        : DEFAULT_COALESCE_WINDOW_MS

    this.maxQueueSize = config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
    this.maxBatchSize = maxBatchSize
    this.flushIntervalMs = flushIntervalMs
    this.dropPolicy = config.dropPolicy ?? "drop_oldest"
    this.coalesceWindowMs = coalesceWindowMs
  }

  size(): number {
    return this.queue.length
  }

  enqueue(event: BufferedUsageEvent): boolean {
    if (this.queue.length >= this.maxQueueSize) {
      if (this.dropPolicy === "reject_newest") {
        return false
      }
      this.queue.shift()
    }

    this.queue.push({
      ...event,
      usage: normalizeUsage(event.usage),
    })

    return true
  }

  startAutoFlush(flush: (batch: BufferedUsageEvent[]) => Promise<UsageBufferFlushResult>): void {
    if (this.timer) return

    this.timer = setInterval(() => {
      void this.flushOnce(flush)
    }, this.flushIntervalMs)
  }

  stopAutoFlush(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  async flushOnce(
    flush: (batch: BufferedUsageEvent[]) => Promise<UsageBufferFlushResult>
  ): Promise<UsageBufferFlushResult> {
    if (this.isFlushing || this.queue.length === 0) {
      return { accepted: 0, rejected: 0 }
    }

    this.isFlushing = true
    const batch = this.dequeueBatch()
    try {
      let result: UsageBufferFlushResult
      try {
        result = await flush(batch)
      } catch (error) {
        for (const event of batch) {
          this.enqueue(event)
        }
        throw error
      }

      if (result.rejected > 0) {
        const retry = batch.slice(Math.max(0, result.accepted))
        for (const event of retry) {
          this.enqueue(event)
        }
      }

      return result
    } finally {
      this.isFlushing = false
    }
  }

  private dequeueBatch(): BufferedUsageEvent[] {
    const source = this.queue.splice(0, this.maxBatchSize)
    const merged = new Map<string, BufferedUsageEvent>()

    for (const event of source) {
      const key = coalesceKey(event, this.coalesceWindowMs)
      const existing = merged.get(key)

      if (!existing) {
        merged.set(key, { ...event, usage: normalizeUsage(event.usage) })
        continue
      }

      merged.set(key, {
        ...existing,
        usage: normalizeUsage(existing.usage) + normalizeUsage(event.usage),
        timestamp: Math.max(existing.timestamp, event.timestamp),
      })
    }

    return Array.from(merged.values())
  }
}
