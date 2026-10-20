import type { PreparedRequest, RequestLimits } from "./request-policy"

const GENERATION_FIELDS = new Set([
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "cache_control",
  "max_tokens",
  "service_tier",
  "speed",
  "inference_geo",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "metadata",
])

const SAFE_BETAS = new Set([
  "claude-code-20250219",
  "oauth-2025-04-20",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
  "structured-outputs-2025-11-13",
  "effort-2025-11-24",
  "token-efficient-tools-2025-02-19",
  "mid-conversation-output-config-2026-07-01",
  "thinking-binding-controls-2026-08-01",
])

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid Anthropic request object")
  return value as Record<string, unknown>
}

function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unsupported budgeted Anthropic request field")
}

function string(value: unknown): void {
  if (typeof value !== "string") throw new Error("Invalid Anthropic text or tool field")
}

function boolean(value: unknown): void {
  if (typeof value !== "boolean") throw new Error("Invalid Anthropic boolean field")
}

function cacheControl(value: unknown): void {
  if (value === undefined || value === null) return
  const cache = record(value)
  fields(cache, ["type", "ttl"])
  if (cache.type !== "ephemeral" || (cache.ttl !== undefined && cache.ttl !== "5m"))
    throw new Error("Only 5m Anthropic prompt caching is budgeted")
}

function textBlock(value: unknown): void {
  const block = record(value)
  fields(block, ["type", "text", "cache_control"])
  if (block.type !== "text") throw new Error("Only explicit Anthropic text is budgeted")
  string(block.text)
  cacheControl(block.cache_control)
}

function textContent(value: unknown): void {
  if (typeof value === "string") return
  if (!Array.isArray(value)) throw new Error("Only explicit Anthropic text is budgeted")
  for (const block of value) textBlock(block)
}

function directCaller(value: unknown): void {
  const caller = record(value)
  fields(caller, ["type"])
  if (caller.type !== "direct") throw new Error("Only local Anthropic tool calls are budgeted")
}

function contentBlock(value: unknown): void {
  const block = record(value)
  switch (block.type) {
    case "text":
      textBlock(block)
      return
    case "thinking":
      fields(block, ["type", "thinking", "signature"])
      string(block.thinking)
      string(block.signature)
      return
    case "redacted_thinking":
      fields(block, ["type", "data"])
      string(block.data)
      return
    case "tool_use":
      fields(block, ["type", "id", "name", "input", "cache_control", "caller"])
      string(block.id)
      string(block.name)
      record(block.input)
      cacheControl(block.cache_control)
      if (block.caller !== undefined) directCaller(block.caller)
      return
    case "tool_result":
      fields(block, ["type", "tool_use_id", "content", "is_error", "cache_control"])
      string(block.tool_use_id)
      if (block.content !== undefined) textContent(block.content)
      if (block.is_error !== undefined) boolean(block.is_error)
      cacheControl(block.cache_control)
      return
    default:
      throw new Error("Only Anthropic text and local tool history are budgeted")
  }
}

function outputConfig(value: unknown): void {
  const config = record(value)
  fields(config, ["effort", "format"])
  if (
    config.effort !== undefined &&
    config.effort !== null &&
    !["low", "medium", "high", "xhigh", "max"].includes(String(config.effort))
  )
    throw new Error("Invalid Anthropic output effort")
  if (config.format !== undefined && config.format !== null) {
    const format = record(config.format)
    fields(format, ["type", "schema"])
    if (format.type !== "json_schema") throw new Error("Unsupported Anthropic output format")
    record(format.schema)
  }
}

function messages(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("Explicit Anthropic messages are required")
  for (const item of value) {
    const message = record(item)
    fields(message, ["role", "content", "output_config"])
    if (!["user", "assistant", "system"].includes(String(message.role)))
      throw new Error("Invalid Anthropic message role")
    if (message.output_config !== undefined) outputConfig(message.output_config)
    if (message.role === "system") {
      textContent(message.content)
    } else if (typeof message.content !== "string") {
      if (!Array.isArray(message.content)) throw new Error("Invalid Anthropic message content")
      for (const block of message.content) contentBlock(block)
    }
  }
}

function tools(value: unknown): void {
  if (!Array.isArray(value)) throw new Error("Only local Anthropic tools are budgeted")
  for (const item of value) {
    const tool = record(item)
    fields(tool, [
      "type",
      "name",
      "description",
      "input_schema",
      "cache_control",
      "strict",
      "eager_input_streaming",
      "allowed_callers",
      "defer_loading",
      "input_examples",
    ])
    if (tool.type !== undefined && tool.type !== "custom")
      throw new Error("Only local Anthropic tools are budgeted")
    string(tool.name)
    if (tool.description !== undefined) string(tool.description)
    if (record(tool.input_schema).type !== "object")
      throw new Error("Anthropic local tools require an object input schema")
    cacheControl(tool.cache_control)
    if (tool.strict !== undefined) boolean(tool.strict)
    if (tool.eager_input_streaming !== undefined && tool.eager_input_streaming !== null)
      boolean(tool.eager_input_streaming)
    if (tool.defer_loading !== undefined && tool.defer_loading !== false)
      throw new Error("Deferred Anthropic tools are not budgeted")
    if (
      tool.allowed_callers !== undefined &&
      (!Array.isArray(tool.allowed_callers) ||
        tool.allowed_callers.some((caller) => caller !== "direct"))
    )
      throw new Error("Only local Anthropic tool callers are budgeted")
    if (tool.input_examples !== undefined) {
      if (!Array.isArray(tool.input_examples)) throw new Error("Invalid Anthropic tool examples")
      for (const example of tool.input_examples) record(example)
    }
  }
}

function toolChoice(value: unknown): void {
  const choice = record(value)
  fields(choice, ["type", "name", "disable_parallel_tool_use"])
  if (!["auto", "any", "tool", "none"].includes(String(choice.type)))
    throw new Error("Invalid Anthropic tool choice")
  if (choice.type === "tool") string(choice.name)
  else if (choice.name !== undefined) throw new Error("Invalid Anthropic tool choice name")
  if (choice.disable_parallel_tool_use !== undefined) boolean(choice.disable_parallel_tool_use)
}

function boundThinking(value: unknown, outputTokens: number): Record<string, unknown> {
  const thinking = record(value)
  fields(thinking, ["type", "budget_tokens", "display", "block_binding"])
  if (
    thinking.display !== undefined &&
    thinking.display !== null &&
    thinking.display !== "summarized" &&
    thinking.display !== "omitted"
  )
    throw new Error("Invalid Anthropic thinking display")
  if (thinking.block_binding !== undefined) {
    const binding = record(thinking.block_binding)
    fields(binding, ["prefix_mismatch_behavior"])
    if (binding.prefix_mismatch_behavior !== "drop_block")
      throw new Error("Unsupported Anthropic thinking block binding")
  }
  switch (thinking.type) {
    case "enabled": {
      const budget = thinking.budget_tokens
      if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < 1024)
        throw new Error("Anthropic thinking budget must be a safe integer of at least 1024")
      if (outputTokens <= 1024) throw new Error("Anthropic output cap cannot cover thinking")
      return { ...thinking, budget_tokens: Math.min(budget, outputTokens - 1) }
    }
    case "adaptive":
    case "between_tools":
    case "disabled":
      if (thinking.budget_tokens !== undefined)
        throw new Error("Only enabled Anthropic thinking accepts a token budget")
      return thinking
    default:
      throw new Error("Unsupported Anthropic thinking mode")
  }
}

export function prepareRequest(value: unknown, limits: RequestLimits): PreparedRequest {
  const payload = record(JSON.parse(JSON.stringify(value)))
  if (payload.model !== limits.modelId) throw new Error("Budgeted model cannot change")
  if (Object.keys(payload).some((key) => !GENERATION_FIELDS.has(key)))
    throw new Error("Unsupported budgeted Anthropic request field")
  if (!Number.isSafeInteger(limits.maxOutputTokens) || limits.maxOutputTokens < 16)
    throw new Error("maxOutputTokens must be a safe integer of at least 16")
  const requested = payload.max_tokens === undefined ? limits.maxOutputTokens : payload.max_tokens
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 16)
    throw new Error("Output token limit must be a safe integer of at least 16")
  const outputTokens = Math.min(requested, limits.maxOutputTokens)
  messages(payload.messages)
  if (payload.system !== undefined) textContent(payload.system)
  if (payload.tools !== undefined) tools(payload.tools)
  if (payload.tool_choice !== undefined) toolChoice(payload.tool_choice)
  if (payload.output_config !== undefined) outputConfig(payload.output_config)
  cacheControl(payload.cache_control)
  for (const key of ["temperature", "top_p", "top_k"]) {
    if (
      payload[key] !== undefined &&
      (typeof payload[key] !== "number" || !Number.isFinite(payload[key]))
    )
      throw new Error("Invalid Anthropic sampling value")
  }
  if (payload.stop_sequences !== undefined) {
    if (!Array.isArray(payload.stop_sequences)) throw new Error("Invalid Anthropic stop sequences")
    for (const sequence of payload.stop_sequences) string(sequence)
  }
  if (payload.metadata !== undefined) {
    const metadata = record(payload.metadata)
    fields(metadata, ["user_id"])
    if (metadata.user_id !== undefined && metadata.user_id !== null) string(metadata.user_id)
  }
  const generation = {
    ...payload,
    max_tokens: outputTokens,
    service_tier: "standard_only",
    stream: limits.mode === "stream",
    ...(payload.speed === undefined ? {} : { speed: "standard" }),
    ...(payload.inference_geo === undefined ? {} : { inference_geo: "global" }),
    ...(payload.thinking === undefined
      ? {}
      : { thinking: boundThinking(payload.thinking, outputTokens) }),
  }
  const messageCount =
    (payload.messages as unknown[]).length + (payload.system === undefined ? 0 : 1)
  return {
    payload: generation,
    body: JSON.stringify(generation),
    outputTokens,
    messages: messageCount,
    tools: Array.isArray(payload.tools) && payload.tools.length > 0,
  }
}

export function validateRoute(
  request: Request,
  _modelId: string,
  _mode?: "stream" | "generate"
): void {
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/messages"))
    throw new Error("Unsupported budgeted Anthropic model route")
}

export function prepareHeaders(headers: Headers): Headers {
  const prepared = new Headers(headers)
  const betas = prepared.get("anthropic-beta")
  if (betas === null) return prepared
  const safe = betas
    .split(",")
    .map((beta) => beta.trim())
    .filter((beta) => SAFE_BETAS.has(beta))
  if (safe.length > 0) prepared.set("anthropic-beta", [...new Set(safe)].join(","))
  else prepared.delete("anthropic-beta")
  return prepared
}
