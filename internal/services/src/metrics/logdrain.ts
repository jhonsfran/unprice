import type { Logger } from "@unprice/logs"
import type { Metric } from "@unprice/metrics"
import type { Metrics } from "./interface"

type LogdrainEnvironment = "development" | "test" | "production" | "preview"
type LogdrainLogger = Logger & {
  emit(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>
  ): void
}

export class LogdrainMetrics implements Metrics {
  private requestId: string
  private readonly logger: LogdrainLogger
  private readonly environment: LogdrainEnvironment
  private readonly service: string
  private colo?: string
  private country?: string
  private continent?: string
  private durableObjectId?: string
  private readonly sampleRate: number

  constructor(opts: {
    requestId: string
    logger: LogdrainLogger
    environment: LogdrainEnvironment
    service: string
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

  public emit(metric: Metric): void {
    const payload = {
      requestId: this.requestId,
      type: "metric",
      time: Date.now(),
      metric,
      environment: this.environment,
      service: this.service,
      colo: this.colo,
      country: this.country,
      continent: this.continent,
      durableObjectId: this.durableObjectId,
      "log.type": "metric",
    } as Record<string, unknown>

    this.logger.emit("info", metric.metric, payload)
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
