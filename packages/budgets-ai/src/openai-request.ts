import type { PreparedRequest } from "./request-policy"

const GENERATION_FIELDS = new Set<string>([
  "input",
  "instructions",
  "model",
  "parallel_tool_calls",
  "personality",
  "reasoning",
  "text",
  "tool_choice",
  "tools",
  "truncation",
  "max_output_tokens",
  "service_tier",
  "background",
  "stream",
  "store",
  "temperature",
  "top_p",
  "include",
  "metadata",
  "user",
  "safety_identifier",
  "prompt_cache_key",
  "prompt_cache_retention",
  "prompt_cache_options",
])

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid model request object")
  return value as Record<string, unknown>
}

function validateText(content: unknown): void {
  if (typeof content === "string") return
  if (!Array.isArray(content)) throw new Error("Only explicit text input is budgeted")
  for (const value of content) {
    const part = record(value)
    if (!["input_text", "output_text", "refusal"].includes(String(part.type)))
      throw new Error("Only explicit text input is budgeted")
  }
}

function validateTools(tools: unknown): void {
  if (!Array.isArray(tools) || tools.some((tool) => record(tool).type !== "function"))
    throw new Error("Only local function tools are budgeted")
}

/** Validates the input and returns how many messages and tool items it holds. */
function validateInput(input: unknown): number {
  if (typeof input === "string") return 1
  if (!Array.isArray(input)) throw new Error("Explicit model input is required")
  for (const value of input) {
    const item = record(value)
    switch (item.type) {
      case undefined:
      case "message":
        validateText(item.content)
        break
      case "function_call_output":
        validateText(item.output)
        break
      case "additional_tools":
        validateTools(item.tools)
        break
      case "function_call":
      case "reasoning":
      case "configuration_update":
        break
      default:
        throw new Error("Unsupported budgeted input item")
    }
  }
  return input.length
}

/** Apply policy after payload transforms, before the SDK selects its stream parser. */
export function prepareRequest(
  value: unknown,
  {
    modelId,
    maxOutputTokens,
    mode,
  }: { modelId: string; maxOutputTokens: number; mode: "stream" | "generate" }
): PreparedRequest {
  const payload = record(JSON.parse(JSON.stringify(value)))
  if (payload.model !== modelId) throw new Error("Budgeted model cannot change")
  if (Object.keys(payload).some((key) => !GENERATION_FIELDS.has(key)))
    throw new Error("Unsupported budgeted request field")
  if (payload.tools !== undefined) validateTools(payload.tools)
  const messages = validateInput(payload.input) + (payload.instructions === undefined ? 0 : 1)
  const requested =
    payload.max_output_tokens === undefined ? maxOutputTokens : payload.max_output_tokens
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 16)
    throw new Error("Output token limit must be a safe integer of at least 16")
  const outputTokens = Math.min(requested, maxOutputTokens)
  const generation: Record<string, unknown> = {
    ...payload,
    max_output_tokens: outputTokens,
    service_tier: "default",
    background: false,
    truncation: "disabled",
    stream: mode === "stream",
  }
  return {
    payload: generation,
    body: JSON.stringify(generation),
    outputTokens,
    messages,
    tools: Array.isArray(payload.tools) && payload.tools.length > 0,
  }
}

export function validateRoute(request: Request): void {
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses"))
    throw new Error("Unsupported budgeted model route")
}
