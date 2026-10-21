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

type InputEvidence =
  | { readonly source: "byte-bound"; readonly tokens: number }
  | { readonly source: "provider-count"; readonly tokens: number }

export interface PreparedBudgetRequest {
  readonly request: Request
  readonly policy: PreparedRequest
  readonly input: InputEvidence
  readonly requestedOutputTokens: number
  readonly outputTokens: number
  readonly minimumOutputTokens: number
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
): Promise<PreparedBudgetRequest> {
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
    policy: prepared,
    requestedOutputTokens: prepared.outputTokens,
    outputTokens: prepared.outputTokens,
    minimumOutputTokens: prepared.minimumOutputTokens,
    input: {
      source: "byte-bound",
      tokens:
        inputBound(prepared.body, prepared.messages) +
        (prepared.tools ? TOOL_PROMPT_TOKENS[protocol] : 0),
    },
  }
}

export function inputTokensForOutput(
  prepared: PreparedBudgetRequest,
  outputTokens: number
): number {
  if (prepared.input.source === "provider-count") return prepared.input.tokens
  return (
    prepared.input.tokens +
    prepared.policy.outputBytes(outputTokens) -
    prepared.policy.outputBytes(prepared.outputTokens)
  )
}

export function resizeBudgetRequest(
  prepared: PreparedBudgetRequest,
  outputTokens: number
): PreparedBudgetRequest {
  return {
    ...prepared,
    request: new Request(prepared.request, {
      body: JSON.stringify(prepared.policy.withOutputTokens(outputTokens)),
    }),
    outputTokens,
    input: { ...prepared.input, tokens: inputTokensForOutput(prepared, outputTokens) },
  }
}

const COUNT_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "parallel_tool_calls",
  "personality",
  "reasoning",
  "text",
  "tool_choice",
  "tools",
  "truncation",
])

export async function countOpenAIInput(
  prepared: PreparedBudgetRequest,
  transport: typeof globalThis.fetch,
  signal: AbortSignal
): Promise<PreparedBudgetRequest> {
  try {
    const url = new URL(prepared.request.url)
    url.pathname += "/input_tokens"
    const headers = new Headers(prepared.request.headers)
    headers.set("accept", "application/json")
    const response = await transport(
      new Request(url, {
        method: "POST",
        headers,
        credentials: prepared.request.credentials,
        body: JSON.stringify(
          Object.fromEntries(
            Object.entries(prepared.policy.payload).filter(([key]) => COUNT_FIELDS.has(key))
          )
        ),
        signal,
      })
    )
    if (!response.ok) throw new Error("Input count failed")
    const value: unknown = await response.json()
    if (
      typeof value !== "object" ||
      value === null ||
      !("object" in value) ||
      value.object !== "response.input_tokens" ||
      !("input_tokens" in value) ||
      typeof value.input_tokens !== "number" ||
      !Number.isSafeInteger(value.input_tokens) ||
      value.input_tokens < 0
    )
      throw new Error("Invalid input count response")
    signal.throwIfAborted()
    return { ...prepared, input: { source: "provider-count", tokens: value.input_tokens } }
  } catch {
    signal.throwIfAborted()
    return prepared
  }
}
