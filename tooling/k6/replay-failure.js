import { check, fail, sleep } from "k6"
import http from "k6/http"
import { Counter } from "k6/metrics"
import {
  buildProperties,
  discoverCustomerUsageProfile,
  normalizeBaseUrl,
  parseJson,
  positiveInteger,
  randomInteger,
} from "./usage-profile.js"

const failedRowsObserved = new Counter("ingestion_failed_rows_observed")
const replayRequestsSent = new Counter("ingestion_replay_requests_sent")
const statusPollsSent = new Counter("ingestion_status_polls_sent")

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL || "http://localhost:8787")
const UNPRICE_TOKEN = __ENV.UNPRICE_TOKEN || ""
const PROJECT_ID = __ENV.PROJECT_ID || ""
const CUSTOMER_ID = __ENV.CUSTOMER_ID || ""
const REPLAY_EVENT_SLUG = trimString(__ENV.REPLAY_EVENT_SLUG)
const REPLAY_AUTO_REPLAY = parseBoolean(__ENV.REPLAY_AUTO_REPLAY, false)
const REPLAY_POLL_INTERVAL_MS = positiveInteger(__ENV.REPLAY_POLL_INTERVAL_MS, 1000)
const REPLAY_POLL_TIMEOUT_MS = positiveInteger(__ENV.REPLAY_POLL_TIMEOUT_MS, 60000)
const REPLAY_WINDOW_MS = positiveInteger(__ENV.REPLAY_WINDOW_MS, 5 * 60 * 1000)

const FAILURE_HEADER = "x-unprice-ingestion-test-failure"
const FAILURE_HEADER_VALUE = "raw_queue_processing_failed"

export const options = {
  scenarios: {
    ingestion_failure_replay: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "3m",
    },
  },
  thresholds: {
    checks: ["rate==1"],
    http_req_failed: ["rate<0.05"],
  },
}

export function setup() {
  validateConfig()

  const profile = discoverCustomerUsageProfile({
    customerId: CUSTOMER_ID,
    projectId: PROJECT_ID,
    postJson,
  })
  const target = selectUsageEvent(profile.usageEvents)

  return {
    target,
  }
}

export default function ({ target }) {
  const sentAt = Date.now()
  const eventId = `evt_k6_replay_failure_${sentAt}_${randomInteger(100000, 999999)}`
  const idempotencyKey = `k6-replay-failure-${target.eventSlug}-${sentAt}-${randomInteger(
    100000,
    999999
  )}`
  const ingestResponse = postJson(
    "/v1/events/ingest",
    {
      customerId: CUSTOMER_ID,
      eventSlug: target.eventSlug,
      id: eventId,
      idempotencyKey,
      timestamp: sentAt,
      properties: buildProperties(target.propertyFields),
    },
    "POST /v1/events/ingest failure test",
    {
      [FAILURE_HEADER]: FAILURE_HEADER_VALUE,
    }
  )

  if (
    !check(ingestResponse, {
      "failure-test event is accepted": (response) => response.status === 202,
    })
  ) {
    fail(`events.ingest failed: ${ingestResponse.status} ${ingestResponse.body}`)
  }

  const failedRow = waitForIngestionStatusRow({
    eventId,
    eventSlug: target.eventSlug,
    fromTs: sentAt - REPLAY_WINDOW_MS,
    state: "failed",
    toTs: sentAt + REPLAY_WINDOW_MS,
  })

  if (
    !check(failedRow, {
      "failed row is replayable": (row) => row?.state === "failed" && row?.replayable === true,
      "failed row has canonical audit id": (row) => typeof row?.canonicalAuditId === "string",
    })
  ) {
    fail(`failed row is not replayable: ${JSON.stringify(failedRow)}`)
  }

  failedRowsObserved.add(1)
  console.info(
    `Replayable failed ingestion row: canonicalAuditId=${failedRow.canonicalAuditId} eventId=${eventId} eventSlug=${target.eventSlug}`
  )

  if (!REPLAY_AUTO_REPLAY) {
    return
  }

  const replayResponse = postJson(
    "/v1/events/ingest/replay",
    {
      canonical_audit_ids: [failedRow.canonicalAuditId],
      project_id: PROJECT_ID,
    },
    "POST /v1/events/ingest/replay"
  )
  replayRequestsSent.add(1)

  if (
    !check(replayResponse, {
      "replay request returns 200": (response) => response.status === 200,
      "replay request re-enqueues one event": (response) => replayCounts(response).replayed === 1,
    })
  ) {
    fail(`events.ingest.replay failed: ${replayResponse.status} ${replayResponse.body}`)
  }

  const processedRow = waitForIngestionStatusRow({
    eventId,
    eventSlug: target.eventSlug,
    fromTs: sentAt - REPLAY_WINDOW_MS,
    state: "processed",
    toTs: Date.now() + REPLAY_WINDOW_MS,
  })

  check(processedRow, {
    "replayed row is processed": (row) => row?.state === "processed",
  })
}

function selectUsageEvent(usageEvents) {
  if (!Array.isArray(usageEvents) || usageEvents.length === 0) {
    fail(`No usage-metered entitlements found for customer ${CUSTOMER_ID}`)
  }

  if (!REPLAY_EVENT_SLUG) {
    return usageEvents[0]
  }

  const target = usageEvents.find((event) => event.eventSlug === REPLAY_EVENT_SLUG)

  if (!target) {
    fail(`No usage-metered entitlement found for REPLAY_EVENT_SLUG=${REPLAY_EVENT_SLUG}`)
  }

  return target
}

function waitForIngestionStatusRow({ eventId, eventSlug, fromTs, state, toTs }) {
  const deadline = Date.now() + REPLAY_POLL_TIMEOUT_MS
  let lastStatus = 0
  let lastBody = ""

  while (Date.now() <= deadline) {
    const response = postJson(
      "/v1/analytics/ingestion/status",
      {
        customer_id: CUSTOMER_ID,
        from_ts: fromTs,
        to_ts: Math.max(toTs, Date.now() + 1),
        event_slug: eventSlug,
        state,
        limit: 100,
      },
      `POST /v1/analytics/ingestion/status ${state}`
    )
    statusPollsSent.add(1)
    lastStatus = response.status
    lastBody = response.body || ""

    if (response.status === 200) {
      const body = parseJson(response)
      const row = body?.recentEvents?.find(
        (event) => event.eventId === eventId && event.state === state
      )

      if (row) {
        return row
      }
    }

    sleep(REPLAY_POLL_INTERVAL_MS / 1000)
  }

  fail(
    `Timed out waiting for ${state} ingestion row for event ${eventId}. Last response: ${lastStatus} ${truncate(
      lastBody,
      500
    )}`
  )
}

function postJson(path, body, name, extraHeaders = {}) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), requestParams(name, extraHeaders))
}

function requestParams(name, extraHeaders = {}) {
  return {
    headers: {
      authorization: `Bearer ${UNPRICE_TOKEN}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    tags: {
      name,
    },
  }
}

function replayCounts(response) {
  const body = parseJson(response)

  return {
    replayed: typeof body?.replayed === "number" ? body.replayed : -1,
    skipped: typeof body?.skipped === "number" ? body.skipped : -1,
  }
}

function validateConfig() {
  if (!UNPRICE_TOKEN) {
    fail("Missing UNPRICE_TOKEN")
  }

  if (!PROJECT_ID) {
    fail("Missing PROJECT_ID")
  }

  if (!CUSTOMER_ID) {
    fail("Missing CUSTOMER_ID")
  }
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase())
}

function trimString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}
