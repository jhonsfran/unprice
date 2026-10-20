import { describe, expect, it } from "vitest"
import { prepareRequest, validateRoute } from "./google-request"

const limits = { modelId: "gemini-2.5-flash", maxOutputTokens: 4096, mode: "stream" as const }
const text = { contents: [{ role: "user", parts: [{ text: "Hello" }] }] }

describe("Gemini request policy", () => {
  it("preserves the smaller serialized cap, system instruction, schema, and local functions", () => {
    const result = prepareRequest(
      {
        ...text,
        systemInstruction: { parts: [{ text: "Be concise" }] },
        tools: [
          { functionDeclarations: [{ name: "weather", parametersJsonSchema: { type: "object" } }] },
        ],
        generationConfig: {
          maxOutputTokens: 32,
          responseMimeType: "application/json",
          responseJsonSchema: { type: "object" },
        },
        serviceTier: "priority",
      },
      limits
    )
    expect(result.outputTokens).toBe(32)
    expect(JSON.parse(result.body)).toEqual({
      ...text,
      systemInstruction: { parts: [{ text: "Be concise" }] },
      tools: [
        { functionDeclarations: [{ name: "weather", parametersJsonSchema: { type: "object" } }] },
      ],
      generationConfig: {
        maxOutputTokens: 32,
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object" },
        candidateCount: 1,
        responseModalities: ["TEXT"],
      },
      serviceTier: "standard",
    })
  })

  it("caps one physical request and retains thinking and replay signatures", () => {
    const input = {
      contents: [
        {
          role: "model",
          parts: [
            { text: "Reason", thought: true, thoughtSignature: "signed" },
            {
              functionCall: { id: "call", name: "weather", args: { city: "Paris" } },
              thoughtSignature: "tool-signed",
            },
          ],
        },
        {
          role: "user",
          parts: [{ functionResponse: { name: "weather", response: { output: "sunny" } } }],
        },
      ],
      generationConfig: { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } },
    }
    expect(prepareRequest(input, { ...limits, maxOutputTokens: 100000 }).outputTokens).toBe(65536)
    expect(
      prepareRequest(input, { ...limits, maxOutputTokens: 100000, mode: "generate" }).outputTokens
    ).toBe(32768)
    expect(prepareRequest(input, limits).payload).toMatchObject(input)
  })

  it.each([
    { cachedContent: "cachedContents/cache" },
    { continuationToken: "continuation" },
    { background: true },
    { contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: "data" } }] }] },
    { contents: [{ parts: [{ fileData: { fileUri: "https://example.com/file" } }] }] },
    {
      contents: [
        {
          parts: [
            {
              functionResponse: {
                name: "weather",
                response: {},
                parts: [{ inlineData: { data: "image" } }],
              },
            },
          ],
        },
      ],
    },
    { tools: [{ functionDeclarations: [{ name: "local" }], googleSearch: {} }] },
    { tools: [{ codeExecution: {} }] },
    { toolConfig: { retrievalConfig: {} } },
    { generationConfig: { candidateCount: 2 } },
    { generationConfig: { responseModalities: ["IMAGE"] } },
    { generationConfig: { imageConfig: {} } },
    { generationConfig: { responseFormat: { audio: {} } } },
    { generationConfig: { thinkingConfig: { futureBillingOption: true } } },
    { tools: [{ functionDeclarations: [{ name: "local", behavior: "NON_BLOCKING" }] }] },
    { generationConfig: { maxOutputTokens: null } },
    { generationConfig: { maxOutputTokens: 15 } },
  ])("rejects unsupported billable request shapes: %j", (extra) => {
    expect(() => prepareRequest({ ...text, ...extra }, limits)).toThrow()
  })

  it.each(["LOW", "low"])("accepts native SDK thinking level %s", (thinkingLevel) => {
    expect(() =>
      prepareRequest({ ...text, generationConfig: { thinkingConfig: { thinkingLevel } } }, limits)
    ).not.toThrow()
  })

  it("binds the final URL model and parser mode", () => {
    const request = (path: string, method = "POST") =>
      new Request(`https://provider.test/v1beta/${path}`, { method })
    expect(() =>
      validateRoute(
        request("models/gemini-2.5-flash:streamGenerateContent?alt=sse"),
        limits.modelId,
        "stream"
      )
    ).not.toThrow()
    expect(() =>
      validateRoute(request("models/gemini-2.5-flash:generateContent"), limits.modelId, "generate")
    ).not.toThrow()
    for (const path of [
      "models/other:generateContent",
      "interactions",
      "models/gemini-2.5-flash:countTokens",
      "models/gemini-2.5-flash:streamGenerateContent",
    ]) {
      expect(() => validateRoute(request(path), limits.modelId, "stream")).toThrow()
    }
    expect(() =>
      validateRoute(request("models/gemini-2.5-flash:generateContent"), limits.modelId, "stream")
    ).toThrow()
    expect(() =>
      validateRoute(request("models/gemini-2.5-flash:generateContent", "GET"), limits.modelId)
    ).toThrow()
  })
})
