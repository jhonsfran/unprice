import type { Fields, Logger } from "@unprice/logging"
import { Log, type LogSchema } from "@unprice/logs"
import type { Metric } from "@unprice/metrics"
import type { Metrics } from "./interface"

export class LogdrainMetrics implements Metrics {
  private requestId: string
  private readonly logger: Logger
  private readonly environment: LogSchema["environment"]
  private readonly service: LogSchema["service"]
  private colo?: string
  private country?: string
  private continent?: string
  private durableObjectId?: string
  private readonly sampleRate: number

  constructor(opts: {
    requestId: string
    logger: Logger
    environment: LogSchema["environment"]
    service: LogSchema["service"]
    colo?: string
    country?: string
    continent?: string
    durableObjectId?: string
    sampleRate?: number
  }) {
    this.requestId = opts.requestId
    this.logger = opts.logger
    this.environment = opts.environment
    this.service = opts.service
    this.colo = opts.colo
    this.country = opts.country
    this.continent = opts.continent
    this.durableObjectId = opts.durableObjectId
    this.sampleRate = opts.sampleRate ?? 0.1
  }

  /**
   * Sampling Logic
   */
  public shouldSample(metric: Metric): boolean {
    // 1. Always keep errors (if metric has status field and it's >= 400)
    if ("status" in metric && typeof metric.status === "number" && metric.status >= 400) {
      return true
    }

    // 2. Always keep slow operations (> 1s)
    const duration =
      "duration" in metric ? metric.duration : "latency" in metric ? metric.latency : undefined
    if (duration !== undefined && duration > 1000) {
      return true
    }

    // 3. Always keep errors (if metric has error field)
    if ("error" in metric && metric.error) {
      return true
    }

    // 4. Sample based on sample rate for healthy metrics
    return Math.random() < this.sampleRate
  }

  public emit(metric: Metric): void {
    // Only emit if shouldSample returns true
    if (!this.shouldSample(metric)) {
      return
    }

    const log = new Log({
      requestId: this.requestId,
      type: "metric",
      time: Date.now(),
      metric,
      environment: this.environment,
      service: this.service,
      colo: this.colo,
      durableObjectId: this.durableObjectId,
    })

    // colo is important to keep track of the location
    this.logger.emit("info", log.toString(), {
      colo: this.colo,
      country: this.country,
      continent: this.continent,
    } as Fields)
  }

  public setColo(colo: string): void {
    this.colo = colo
  }

  public getColo(): string {
    return this.colo ?? "UNK"
  }

  public async flush(): Promise<void> {
    return this.logger.flush()
  }

  public x(value: string): void {
    this.requestId = value
  }
}
