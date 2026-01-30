import type { Metric } from "@unprice/metrics"

export interface Metrics {
  /**
   * setRequestId sets the request id for the metrics
   */
  x(value: string): void

  /**
   * Emit stores a new metric event
   */
  emit(metric: Metric): void

  /**
   * flush persists all metrics to durable storage
   */
  flush(): Promise<void>

  /**
   * setColo sets the colo of the metrics
   */
  setColo(colo: string): void

  /**
   * getColo gets the colo of the metrics
   */
  getColo(): string
}
