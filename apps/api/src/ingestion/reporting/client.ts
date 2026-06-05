import type {
  IngestionReportingEnvelope,
  IngestionReportingQueueClient,
} from "@unprice/services/ingestion"
import type { Env } from "~/env"

export class CloudflareReportingQueueClient implements IngestionReportingQueueClient {
  private readonly queue: Queue<IngestionReportingEnvelope>

  constructor(env: Pick<Env, "INGESTION_REPORTING_QUEUE">) {
    this.queue = env.INGESTION_REPORTING_QUEUE as Queue<IngestionReportingEnvelope>
  }

  public async send(envelope: IngestionReportingEnvelope): Promise<void> {
    await this.queue.send(envelope)
  }
}
