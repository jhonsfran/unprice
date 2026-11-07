import { attributionIdSchema } from "@unprice/db/validators"
import { type WebEventRow, createWebEventRow } from "@unprice/lakehouse"
import { z } from "zod"

/** A pricing page shows a handful of plans; a beacon naming more is not one of ours. */
export const MAX_PLAN_IDS_PER_HIT = 20

const text = (max: number) => z.string().max(max)

/** track.js `page_hit` payload. `plan_ids` is the page's comma-separated plan version ids. */
export const pageHitPayloadSchema = z.object({
  page_id: attributionIdSchema,
  plan_ids: text(4_096)
    .nullish()
    .transform((value) => [...new Set((value ?? "").split(",").filter((id) => id.length > 0))])
    .pipe(z.array(attributionIdSchema).max(MAX_PLAN_IDS_PER_HIT)),
  locale: text(64).nullish(),
  referrer: text(2_048).nullish(),
  pathname: text(2_048),
  url: text(2_048),
})
export type PageHitPayload = z.infer<typeof pageHitPayloadSchema>

/** track.js `plan_click` payload. */
export const planClickPayloadSchema = z.object({
  plan_version_id: attributionIdSchema,
  page_id: attributionIdSchema,
})

/** The beacon envelope; `payload` is a JSON string whose shape depends on `action`. */
export const trackingBodySchema = z.object({
  action: z.enum(["page_hit", "plan_click"]),
  session_id: attributionIdSchema,
  project_id: attributionIdSchema,
  payload: z.string().max(8_192),
})

type Envelope = { session_id: string; project_id: string }

export type TrackingRequest =
  | (Envelope & { action: "page_hit"; payload: PageHitPayload })
  | (Envelope & { action: "plan_click"; payload: z.infer<typeof planClickPayloadSchema> })

/**
 * Validates a beacon body. The envelope's session and project ids are the only ones used: payload
 * keys are parsed into their own object and can never override them.
 */
export function parseTrackingRequest(
  body: unknown
): { success: true; data: TrackingRequest } | { success: false; error: string } {
  const envelope = trackingBodySchema.safeParse(body)
  if (!envelope.success) {
    return { success: false, error: z.prettifyError(envelope.error) }
  }

  let payload: unknown
  try {
    payload = JSON.parse(envelope.data.payload)
  } catch {
    return { success: false, error: "Invalid payload JSON" }
  }

  const { action, session_id, project_id } = envelope.data
  if (action === "page_hit") {
    const parsed = pageHitPayloadSchema.safeParse(payload)
    return parsed.success
      ? { success: true, data: { action, session_id, project_id, payload: parsed.data } }
      : { success: false, error: z.prettifyError(parsed.error) }
  }

  const parsed = planClickPayloadSchema.safeParse(payload)
  return parsed.success
    ? { success: true, data: { action, session_id, project_id, payload: parsed.data } }
    : { success: false, error: z.prettifyError(parsed.error) }
}

/** One `plan_view` row per distinct plan the hit's page showed. */
export function planViewRows(hit: Envelope & { payload: PageHitPayload }): WebEventRow[] {
  return hit.payload.plan_ids.map((planVersionId) =>
    createWebEventRow({
      kind: "plan_view",
      session_id: hit.session_id,
      project_id: hit.project_id,
      page_id: hit.payload.page_id,
      plan_version_id: planVersionId,
    })
  )
}
