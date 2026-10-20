import * as anthropic from "./anthropic-request"
import * as google from "./google-request"
import { inputBound } from "./input-bound"
import * as openai from "./openai-request"
import type { BudgetProtocol, PreparedRequest, RequestLimits } from "./request-policy"

/**
 * Validates the final serialized request, clamps its output limit, and bounds its input tokens by
 * its bytes. No provider round trip: the bound is computed, not counted.
 */
export async function prepareBudgetRequest(
  incoming: Request,
  limits: RequestLimits,
  protocol: BudgetProtocol
): Promise<{ request: Request; outputTokens: number; inputTokens: number }> {
  const value: unknown = await incoming.clone().json()
  let prepared: PreparedRequest
  let headers = new Headers(incoming.headers)
  switch (protocol) {
    case "openai-responses":
      openai.validateRoute(incoming)
      prepared = openai.prepareRequest(value, limits)
      break
    case "anthropic-messages":
      anthropic.validateRoute(incoming, limits.modelId, limits.mode)
      prepared = anthropic.prepareRequest(value, limits)
      headers = anthropic.prepareHeaders(headers)
      break
    case "google-generative-ai":
      google.validateRoute(incoming, limits.modelId, limits.mode)
      prepared = google.prepareRequest(value, limits)
      break
    default:
      throw new Error("Unsupported budgeted model protocol")
  }
  headers.delete("content-length")
  headers.delete("transfer-encoding")
  const request = new Request(incoming, { headers, body: prepared.body })
  return {
    request,
    outputTokens: prepared.outputTokens,
    inputTokens: inputBound(prepared.body, prepared.messages),
  }
}
