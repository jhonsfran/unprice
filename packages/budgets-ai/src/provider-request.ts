import * as anthropic from "./anthropic-request"
import * as google from "./google-request"
import * as openai from "./openai-request"
import type { BudgetProtocol, ModelLimits, PreparedRequest, RequestLimits } from "./request-policy"

export async function prepareBudgetRequest(
  incoming: Request,
  limits: RequestLimits,
  protocol: BudgetProtocol,
  modelLimits: ModelLimits | undefined,
  transport: typeof fetch
): Promise<{ request: Request; outputTokens: number; inputTokens: number }> {
  const value: unknown = await incoming.clone().json()
  let prepared: PreparedRequest
  let inputBound: (request: Request) => Promise<number>
  let headers = new Headers(incoming.headers)
  switch (protocol) {
    case "openai-responses": {
      const counted = openai.prepareRequest(value, limits)
      prepared = counted
      inputBound = (request) => openai.countInputTokens(request, counted, transport)
      break
    }
    case "anthropic-messages":
    case "google-generative-ai": {
      if (!modelLimits) throw new Error("Trusted model limits are required for this protocol")
      const policy = protocol === "anthropic-messages" ? anthropic : google
      policy.validateRoute(incoming, limits.modelId, limits.mode)
      prepared = policy.prepareRequest(value, limits)
      if (protocol === "anthropic-messages") headers = anthropic.prepareHeaders(headers)
      const bound = modelLimits.maxInputTokens
      inputBound = async () => bound
      break
    }
    default:
      throw new Error("Unsupported budgeted model protocol")
  }
  headers.delete("content-length")
  headers.delete("transfer-encoding")
  const request = new Request(incoming, { headers, body: prepared.body })
  return { request, outputTokens: prepared.outputTokens, inputTokens: await inputBound(request) }
}
