import * as anthropic from "./anthropic-request"
import * as google from "./google-request"
import { inputBound } from "./input-bound"
import * as openai from "./openai-request"
import type { BudgetProtocol, PreparedRequest, RequestLimits } from "./request-policy"

/**
 * Input tokens a provider adds outside the request body when it carries tools. Anthropic's tool-use
 * docs (read 2026-10-20) list a hidden tool-use system prompt of 264 to 804 tokens by model and
 * `tool_choice`; OpenAI's and Google's docs list none.
 */
export const TOOL_PROMPT_TOKENS: Readonly<Record<BudgetProtocol, number>> = {
  "openai-responses": 0,
  "anthropic-messages": 1024,
  "google-generative-ai": 0,
}

/**
 * Validates the final serialized request, clamps its output limit, and bounds its input tokens by
 * its bytes plus what the provider adds for tools. No provider round trip: the bound is computed,
 * not counted.
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
    inputTokens:
      inputBound(prepared.body, prepared.messages) +
      (prepared.tools ? TOOL_PROMPT_TOKENS[protocol] : 0),
  }
}
