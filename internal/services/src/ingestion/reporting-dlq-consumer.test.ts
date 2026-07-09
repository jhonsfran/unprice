import { describe, expect, it, vi } from "vitest"
import type { IngestionReportingEnvelope } from "./reporting"
import { REPORTING_MAX_REDRIVES, ReportingDlqConsumer } from "./reporting-dlq-consumer"

describe("ReportingDlqConsumer", () => {
  for (const [redriveCount, expectedCount, expectedDelay] of [
    [0, 1, 60],
    [1, 2, 120],
    [2, 3, 180],
  ] as const) {
    it(`re-drives count ${redriveCount} with count ${expectedCount} after ${expectedDelay} seconds`, async () => {
      const logger = createLogger()
      const redrive = vi.fn().mockResolvedValue(undefined)
      const message = createQueueMessage(createEnvelope({ redriveCount }))
      const consumer = new ReportingDlqConsumer({ logger, redrive })

      await consumer.consumeBatch({ messages: [message] })

      expect(redrive).toHaveBeenCalledWith(createEnvelope({ redriveCount: expectedCount }), {
        delaySeconds: expectedDelay,
      })
      expect(message.ack).toHaveBeenCalledOnce()
      expect(message.retry).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith("ingestion reporting envelope re-driven from DLQ", {
        envelope_id: "env_1",
        project_id: "proj_1",
        customer_id: "cus_1",
        redrive_count: expectedCount,
        delay_seconds: expectedDelay,
      })
    })
  }

  it("logs the full envelope and acknowledges after the redrive cap", async () => {
    const logger = createLogger()
    const redrive = vi.fn()
    const envelope = createEnvelope({ redriveCount: REPORTING_MAX_REDRIVES })
    const message = createQueueMessage(envelope)
    const consumer = new ReportingDlqConsumer({ logger, redrive })

    await consumer.consumeBatch({ messages: [message] })

    expect(redrive).not.toHaveBeenCalled()
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith("ingestion reporting envelope permanently failed", {
      envelope_id: "env_1",
      project_id: "proj_1",
      customer_id: "cus_1",
      redrive_count: REPORTING_MAX_REDRIVES,
      reporting_audit_record_count: 0,
      reporting_meter_fact_count: 0,
      envelope_json: JSON.stringify(envelope),
    })
    expect(logger.error.mock.calls[0]?.[1]?.envelope_json).toContain("env_1")
  })

  it("retries without acknowledging when redrive fails", async () => {
    const logger = createLogger()
    const error = new Error("queue unavailable")
    const envelope = createEnvelope()
    const message = createQueueMessage(envelope)
    const consumer = new ReportingDlqConsumer({
      logger,
      redrive: vi.fn().mockRejectedValue(error),
    })

    await consumer.consumeBatch({ messages: [message] })

    expect(message.retry).toHaveBeenCalledOnce()
    expect(message.ack).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(error, {
      operation: "ingestion_reporting_dlq_redrive",
      envelope_id: "env_1",
      project_id: "proj_1",
      customer_id: "cus_1",
      redrive_count: 0,
      reporting_audit_record_count: 0,
      reporting_meter_fact_count: 0,
      envelope_json: JSON.stringify(envelope),
    })
    expect(logger.error.mock.calls[0]?.[1]?.envelope_json).toContain("env_1")
  })

  it("acknowledges and logs malformed messages without re-driving them", async () => {
    const logger = createLogger()
    const redrive = vi.fn()
    const message = createQueueMessage({ malformed: true } as never)
    const consumer = new ReportingDlqConsumer({ logger, redrive })

    await consumer.consumeBatch({ messages: [message] })

    expect(redrive).not.toHaveBeenCalled()
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      "dropping malformed reporting DLQ message",
      expect.objectContaining({ errors: expect.any(Array) })
    )
  })
})

function createEnvelope(
  overrides: Partial<IngestionReportingEnvelope> = {}
): IngestionReportingEnvelope {
  return {
    kind: "ingestion.reporting.v1",
    envelopeId: "env_1",
    createdAt: 1,
    projectId: "proj_1",
    customerId: "cus_1",
    redriveCount: 0,
    auditRecords: [],
    meterFacts: [],
    ...overrides,
  }
}

function createQueueMessage(body: IngestionReportingEnvelope) {
  return {
    ack: vi.fn(),
    body,
    retry: vi.fn(),
  }
}

function createLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  }
}
