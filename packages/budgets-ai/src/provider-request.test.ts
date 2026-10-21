import { describe, expect, it } from "vitest"
import { inputBound } from "./input-bound"
import { inputTokensForOutput, prepareBudgetRequest, resizeBudgetRequest } from "./provider-request"
import type { BudgetProtocol } from "./request-policy"

const cases: { protocol: BudgetProtocol; url: string; payload: object; allowances: number[] }[] = [
  {
    protocol: "openai-responses",
    url: "https://provider.test/v1/responses",
    payload: { model: "model", input: "Hello", max_output_tokens: 20_000 },
    allowances: [10_000, 9999, 100, 99, 16],
  },
  {
    protocol: "anthropic-messages",
    url: "https://provider.test/v1/messages",
    payload: {
      model: "model",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 20_000,
      thinking: { type: "enabled", budget_tokens: 15_000 },
    },
    allowances: [10_001, 10_000, 9999, 1025],
  },
  {
    protocol: "google-generative-ai",
    url: "https://provider.test/v1beta/models/model:generateContent",
    payload: {
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      generationConfig: { maxOutputTokens: 20_000 },
    },
    allowances: [10_000, 9999, 100, 99, 16],
  },
]

describe.each(cases)("prepared $protocol request", ({ protocol, url, payload, allowances }) => {
  it("keeps the byte bound exact across successive output reductions", async () => {
    const original = await prepareBudgetRequest(
      new Request(url, { method: "POST", body: JSON.stringify(payload) }),
      { modelId: "model", maxOutputTokens: 20_000, mode: "generate" },
      protocol
    )
    const originalBody = await original.request.clone().text()
    let prepared = original
    for (const outputTokens of allowances) {
      const inputTokens = inputTokensForOutput(prepared, outputTokens)
      prepared = resizeBudgetRequest(prepared, outputTokens)
      const body = await prepared.request.clone().text()
      expect(inputTokens).toBe(inputBound(body, 1))
      expect(prepared.input).toEqual({ source: "byte-bound", tokens: inputBound(body, 1) })
      expect(prepared.outputTokens).toBe(outputTokens)
      expect(prepared.request.url).toBe(url)
    }
    expect(await original.request.text()).toBe(originalBody)
    expect(original.outputTokens).toBe(20_000)
  })
})
