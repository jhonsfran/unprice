import type { Metric } from "@unprice/metrics"
import type { Metrics } from "./interface"

export class NoopMetrics implements Metrics {
  public x(_value: string): void {
    return
  }

  public emit(_metric: Metric): Promise<void> {
    return Promise.resolve()
  }

  public setColo(_colo: string): void {
    return
  }

  public getColo(): string {
    return "UNK"
  }

  public async flush(): Promise<void> {}
}
