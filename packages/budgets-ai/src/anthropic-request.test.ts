import { describe, expect, it } from "vitest"
import { prepareHeaders, prepareRequest, validateRoute } from "./anthropic-request"

const limits = { modelId: "claude-test", maxOutputTokens: 4096, mode: "generate" } as const

function request(overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-test",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 64,
    ...overrides,
  }
}

const tool = {
  name: "weather",
  description: "Get local weather",
  input_schema: { type: "object", properties: { city: { type: "string" } } },
}
const cache = { type: "ephemeral", ttl: "5m" }

describe("Anthropic Messages request policy", () => {
  it("sets standard capacity, preserves a smaller cap and JSON mode, and snapshots the body", () => {
    const payload = request({ stream: true, service_tier: "auto" })
    const prepared = prepareRequest(payload, limits)
    payload.messages[0] = { role: "user", content: "Changed later" }
    expect(prepared.outputTokens).toBe(64)
    expect(JSON.parse(prepared.body)).toEqual({
      model: "claude-test",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 64,
      service_tier: "standard_only",
      stream: false,
    })
    expect(prepared.payload).toEqual(JSON.parse(prepared.body))
  })

  it("caps the output after serialization and preserves streaming", () => {
    const prepared = prepareRequest(request({ max_tokens: 100_000, stream: false }), {
      ...limits,
      mode: "stream",
    })
    expect(JSON.parse(prepared.body)).toMatchObject({ max_tokens: 4096, stream: true })
    expect(prepared.outputTokens).toBe(4096)
  })

  it("uses the configured cap when the request omits max_tokens", () => {
    expect(prepareRequest(request({ max_tokens: undefined }), limits).outputTokens).toBe(4096)
  })

  it("normalizes speed and geography only when those fields are present", () => {
    const absent = JSON.parse(prepareRequest(request(), limits).body)
    expect(absent).not.toHaveProperty("speed")
    expect(absent).not.toHaveProperty("inference_geo")
    const supplied = JSON.parse(
      prepareRequest(request({ speed: "fast", inference_geo: "us" }), limits).body
    )
    expect(supplied).toMatchObject({ speed: "standard", inference_geo: "global" })
  })

  it("accepts local tools and text results with thinking history and 5m cache breakpoints", () => {
    const messages = [
      { role: "system", content: [], output_config: { effort: "high" } },
      { role: "user", content: [{ type: "text", text: "Weather?", cache_control: cache }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Check weather", signature: "signed" },
          { type: "redacted_thinking", data: "opaque" },
          {
            type: "tool_use",
            id: "tool_1",
            name: "weather",
            input: { city: "Bogota" },
            caller: { type: "direct" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: [{ type: "text", text: "Clear", cache_control: { type: "ephemeral" } }],
            is_error: false,
            cache_control: cache,
          },
        ],
      },
    ]
    const payload = request({
      messages,
      system: [{ type: "text", text: "Use local tools", cache_control: cache }],
      tools: [{ ...tool, cache_control: cache, strict: true, eager_input_streaming: true }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      cache_control: cache,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: { type: "object" } },
      },
    })
    expect(JSON.parse(prepareRequest(payload, limits).body)).toMatchObject(payload)
  })

  it("keeps JSON schema and tool arguments as data", () => {
    const data = { type: "web_search_20250305", cache_control: { type: "ephemeral", ttl: "1h" } }
    const payload = request({
      tools: [{ ...tool, input_schema: { type: "object", properties: data } }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "weather", input: data }],
        },
      ],
    })
    expect(() => prepareRequest(payload, limits)).not.toThrow()
  })

  it("bounds manual thinking within the final output cap", () => {
    const prepared = prepareRequest(
      request({ max_tokens: 8000, thinking: { type: "enabled", budget_tokens: 7000 } }),
      limits
    )
    expect(JSON.parse(prepared.body)).toMatchObject({
      max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 4095 },
    })
  })

  it("preserves supported adaptive thinking binding controls", () => {
    const thinking = {
      type: "adaptive",
      display: "omitted",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    }
    expect(JSON.parse(prepareRequest(request({ thinking }), limits).body).thinking).toEqual(
      thinking
    )
  })

  it.each([0, 15, 16.5, null, "64", Number.POSITIVE_INFINITY])(
    "rejects invalid final max_tokens %s",
    (max_tokens) => {
      expect(() => prepareRequest(request({ max_tokens }), limits)).toThrow("token limit")
    }
  )

  it.each([0, 15, 16.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid configured cap %s",
    (maxOutputTokens) => {
      expect(() => prepareRequest(request(), { ...limits, maxOutputTokens })).toThrow(
        "maxOutputTokens"
      )
    }
  )

  it.each([
    { type: "enabled", budget_tokens: 1023 },
    { type: "enabled", budget_tokens: 1024.5 },
    { type: "enabled", budget_tokens: "2048" },
    { type: "enabled" },
    { type: "adaptive", budget_tokens: 2048 },
    { type: "unknown" },
    { type: "adaptive", display: "raw" },
    { type: "adaptive", block_binding: { prefix_mismatch_behavior: "unknown" } },
  ])("rejects malformed thinking %j", (thinking) => {
    expect(() => prepareRequest(request({ thinking, max_tokens: 4096 }), limits)).toThrow(
      "thinking"
    )
  })

  it("rejects manual thinking when the output cap cannot cover its minimum", () => {
    expect(() =>
      prepareRequest(request({ thinking: { type: "enabled", budget_tokens: 1024 } }), limits)
    ).toThrow("cannot cover thinking")
  })

  it.each([
    { cache_control: { type: "ephemeral", ttl: "1h" } },
    { system: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } }] },
    { tools: [{ ...tool, cache_control: { type: "ephemeral", ttl: "1h" } }] },
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } },
          ],
        },
      ],
    },
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t",
              content: [
                { type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } },
              ],
            },
          ],
        },
      ],
    },
  ])("rejects 1h cache writes at each supported location %j", (unsupported) => {
    expect(() => prepareRequest(request(unsupported), limits)).toThrow("5m")
  })

  it.each([
    { tools: [{ type: "web_search_20250305", name: "web_search" }] },
    { tools: [{ type: "advisor_20260301", name: "advisor", model: "other" }] },
    { tools: [{ ...tool, allowed_callers: ["code_execution_20260120"] }] },
    { tools: [{ ...tool, defer_loading: true }] },
    { tools: [{ ...tool, server_option: true }] },
    { mcp_servers: [] },
    { container: "existing-container" },
    { context_management: { edits: [{ type: "compact_20260112" }] } },
    { fallbacks: [{ model: "other" }] },
    { output_config: { task_budget: { type: "tokens", total: 100_000 } } },
    {
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://example.test/image" } }],
        },
      ],
    },
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t",
              content: [{ type: "document", source: { type: "text", data: "text" } }],
            },
          ],
        },
      ],
    },
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "server_tool_use", id: "t", name: "web_search", input: {} }],
        },
      ],
    },
    {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t",
              name: "weather",
              input: {},
              caller: { type: "code_execution_20260120", tool_id: "server" },
            },
          ],
        },
      ],
    },
  ])("rejects unsupported charges or hidden features %j", (unsupported) => {
    expect(() => prepareRequest(request(unsupported), limits)).toThrow()
  })

  it.each([
    { model: "other-model" },
    { messages: undefined },
    { messages: [] },
    { messages: [{ role: "unknown", content: "Hello" }] },
    { messages: [{ role: "user", content: { text: "Hello" } }] },
    { tools: [{ ...tool, input_schema: { type: "string" } }] },
    { tool_choice: { type: "tool" } },
    { output_config: { effort: "unlimited" } },
    { metadata: { unknown: "value" } },
  ])("rejects malformed or changed model inputs %j", (invalid) => {
    expect(() => prepareRequest(request(invalid), limits)).toThrow()
  })
})

describe("Anthropic dispatch route and headers", () => {
  it("accepts the native Messages POST route, including the SDK beta query", () => {
    expect(() =>
      validateRoute(
        new Request("https://api.anthropic.com/v1/messages?beta=true", { method: "POST" }),
        "claude-test"
      )
    ).not.toThrow()
  })

  it.each([
    ["GET", "/v1/messages"],
    ["POST", "/v1/messages/count_tokens"],
    ["POST", "/v1/messages/batches"],
    ["POST", "/v1/responses"],
  ])("rejects %s %s", (method, path) => {
    expect(() =>
      validateRoute(new Request(`https://api.anthropic.com${path}`, { method }), "claude-test")
    ).toThrow("route")
  })

  it("removes unsafe and unknown betas while preserving safe native SDK behavior", () => {
    const original = new Headers({
      "x-api-key": "test",
      "anthropic-beta":
        "server-side-fallback-2026-07-01, interleaved-thinking-2025-05-14, context-1m-2025-08-07,unknown-beta, fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
    })
    const prepared = prepareHeaders(original)
    expect(prepared.get("anthropic-beta")).toBe(
      "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"
    )
    expect(prepared.get("x-api-key")).toBe("test")
    expect(original.get("anthropic-beta")).toContain("server-side-fallback")
  })

  it("removes the beta header when no supported beta remains", () => {
    expect(
      prepareHeaders(new Headers({ "anthropic-beta": "context-management-2025-06-27" })).has(
        "anthropic-beta"
      )
    ).toBe(false)
  })
})
