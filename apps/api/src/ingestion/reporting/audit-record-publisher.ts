import type { PipelineRecord } from "cloudflare:pipelines"
import { parseLakehouseEvent } from "@unprice/lakehouse"
import type { IngestionReportingAuditRecord } from "@unprice/services/ingestion"
import type { Env } from "~/env"

export type AuditRecordPublisher = (records: IngestionReportingAuditRecord[]) => Promise<void>

export function createAuditRecordPublisher(
  env: Pick<Env, "APP_ENV" | "LOCAL_PIPELINE_URL" | "PIPELINE_EVENTS">
): AuditRecordPublisher {
  return async (records) => {
    if (records.length === 0) {
      return
    }

    const events = records.map(toPipelineRecord)
    const localPipelineUrl = resolveLocalPipelineUrl(env)

    if (localPipelineUrl) {
      await sendToLocalPipeline(localPipelineUrl, events)
      return
    }

    if (!env.PIPELINE_EVENTS) {
      throw new Error("PIPELINE_EVENTS binding is required when LOCAL_PIPELINE_URL is not set")
    }

    await env.PIPELINE_EVENTS.send(events)
  }
}

function toPipelineRecord(record: IngestionReportingAuditRecord): PipelineRecord {
  const payload = JSON.parse(record.auditPayloadJson)
  return parseLakehouseEvent("events", payload) as PipelineRecord
}

function resolveLocalPipelineUrl(env: Pick<Env, "APP_ENV" | "LOCAL_PIPELINE_URL">): string | null {
  if (env.APP_ENV !== "development") {
    return null
  }

  const localPipelineUrl = env.LOCAL_PIPELINE_URL?.trim()
  return localPipelineUrl && localPipelineUrl.length > 0 ? localPipelineUrl : null
}

async function sendToLocalPipeline(url: string, events: PipelineRecord[]): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(events),
  })

  if (!response.ok) {
    throw new Error(`local pipeline sink failed with status ${response.status}`)
  }
}
