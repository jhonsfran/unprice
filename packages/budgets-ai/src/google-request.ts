import type { PreparedRequest, RequestLimits } from "./request-policy"

const FIELDS = new Set([
  "contents",
  "systemInstruction",
  "tools",
  "toolConfig",
  "safetySettings",
  "generationConfig",
  "serviceTier",
  "store",
])
const CONFIG_FIELDS = new Set([
  "maxOutputTokens",
  "candidateCount",
  "responseModalities",
  "temperature",
  "topP",
  "topK",
  "stopSequences",
  "responseMimeType",
  "responseSchema",
  "responseJsonSchema",
  "seed",
  "presencePenalty",
  "frequencyPenalty",
  "responseLogprobs",
  "logprobs",
  "thinkingConfig",
])

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid Gemini request object")
  return value as Record<string, unknown>
}

function fields(value: Record<string, unknown>, allowed: Set<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("Unsupported budgeted Gemini field")
}

function optionalString(value: unknown): void {
  if (value !== undefined && typeof value !== "string") throw new Error("Invalid Gemini string")
}

function validatePart(value: unknown, instruction: boolean): void {
  const part = record(value)
  fields(part, new Set(["text", "thought", "thoughtSignature", "functionCall", "functionResponse"]))
  optionalString(part.text)
  optionalString(part.thoughtSignature)
  if (part.thought !== undefined && typeof part.thought !== "boolean")
    throw new Error("Invalid Gemini thought marker")
  const data = ["text", "functionCall", "functionResponse"].filter((key) => key in part)
  if (data.length > 1 || (data.length === 0 && typeof part.thoughtSignature !== "string"))
    throw new Error("Only explicit Gemini text and local function input is budgeted")
  if (instruction && (part.functionCall !== undefined || part.functionResponse !== undefined))
    throw new Error("Only text system instructions are budgeted")
  for (const key of ["functionCall", "functionResponse"]) {
    if (part[key] === undefined) continue
    const call = record(part[key])
    fields(
      call,
      new Set(key === "functionCall" ? ["id", "name", "args"] : ["id", "name", "response"])
    )
    if (typeof call.name !== "string" || !call.name) throw new Error("Invalid Gemini function name")
    optionalString(call.id)
    const content = key === "functionCall" ? call.args : call.response
    if (content !== undefined) record(content)
  }
}

function validateContent(value: unknown, instruction = false): void {
  const content = record(value)
  fields(content, new Set(["parts", "role"]))
  if (
    content.role !== undefined &&
    !(instruction ? ["system", "user", "model"] : ["user", "model"]).includes(String(content.role))
  )
    throw new Error("Invalid Gemini content role")
  if (!Array.isArray(content.parts) || content.parts.length === 0)
    throw new Error("Explicit Gemini content parts are required")
  for (const part of content.parts) validatePart(part, instruction)
}

function validateTools(value: unknown): void {
  if (!Array.isArray(value)) throw new Error("Invalid Gemini tools")
  for (const item of value) {
    const tool = record(item)
    fields(tool, new Set(["functionDeclarations"]))
    if (!Array.isArray(tool.functionDeclarations) || tool.functionDeclarations.length === 0)
      throw new Error("Only local function tools are budgeted")
    for (const item of tool.functionDeclarations) {
      const declaration = record(item)
      fields(
        declaration,
        new Set([
          "name",
          "description",
          "parameters",
          "parametersJsonSchema",
          "response",
          "responseJsonSchema",
          "behavior",
        ])
      )
      if (typeof declaration.name !== "string" || !declaration.name)
        throw new Error("Invalid Gemini function declaration")
      optionalString(declaration.description)
      if (declaration.behavior !== undefined && declaration.behavior !== "BLOCKING")
        throw new Error("Only blocking local function tools are budgeted")
      for (const key of ["parameters", "parametersJsonSchema", "response", "responseJsonSchema"])
        if (declaration[key] !== undefined) record(declaration[key])
    }
  }
}

function validateConfig(config: Record<string, unknown>): void {
  fields(config, CONFIG_FIELDS)
  if (config.candidateCount !== undefined && config.candidateCount !== 1)
    throw new Error("Only one Gemini candidate is budgeted")
  if (
    config.responseModalities !== undefined &&
    (!Array.isArray(config.responseModalities) ||
      config.responseModalities.length !== 1 ||
      config.responseModalities[0] !== "TEXT")
  )
    throw new Error("Only Gemini text output is budgeted")
  if (
    config.responseMimeType !== undefined &&
    config.responseMimeType !== "text/plain" &&
    config.responseMimeType !== "application/json"
  )
    throw new Error("Only Gemini text output is budgeted")
  if (config.thinkingConfig !== undefined) {
    const thinking = record(config.thinkingConfig)
    fields(thinking, new Set(["includeThoughts", "thinkingBudget", "thinkingLevel"]))
    if (thinking.includeThoughts !== undefined && typeof thinking.includeThoughts !== "boolean")
      throw new Error("Invalid Gemini thinking configuration")
    if (
      thinking.thinkingBudget !== undefined &&
      (typeof thinking.thinkingBudget !== "number" ||
        !Number.isSafeInteger(thinking.thinkingBudget) ||
        thinking.thinkingBudget < -1)
    )
      throw new Error("Invalid Gemini thinking budget")
    if (
      thinking.thinkingLevel !== undefined &&
      ![
        "THINKING_LEVEL_UNSPECIFIED",
        "MINIMAL",
        "LOW",
        "MEDIUM",
        "HIGH",
        "minimal",
        "low",
        "medium",
        "high",
      ].includes(String(thinking.thinkingLevel))
    )
      throw new Error("Invalid Gemini thinking level")
  }
}

export function prepareRequest(value: unknown, limits: RequestLimits): PreparedRequest {
  const payload = record(JSON.parse(JSON.stringify(value)))
  fields(payload, FIELDS)
  if (!Array.isArray(payload.contents) || payload.contents.length === 0)
    throw new Error("Explicit Gemini input is required")
  for (const content of payload.contents) validateContent(content)
  if (payload.systemInstruction !== undefined) validateContent(payload.systemInstruction, true)
  if (payload.tools !== undefined) validateTools(payload.tools)
  if (payload.toolConfig !== undefined) {
    const tools = record(payload.toolConfig)
    fields(tools, new Set(["functionCallingConfig"]))
    if (tools.functionCallingConfig !== undefined) {
      const call = record(tools.functionCallingConfig)
      fields(call, new Set(["mode", "allowedFunctionNames"]))
      if (
        call.mode !== undefined &&
        !["AUTO", "ANY", "NONE", "VALIDATED", "MODE_UNSPECIFIED"].includes(String(call.mode))
      )
        throw new Error("Invalid Gemini function mode")
      if (
        call.allowedFunctionNames !== undefined &&
        (!Array.isArray(call.allowedFunctionNames) ||
          call.allowedFunctionNames.some((name) => typeof name !== "string"))
      )
        throw new Error("Invalid Gemini allowed functions")
    }
  }
  if (payload.safetySettings !== undefined) {
    if (!Array.isArray(payload.safetySettings)) throw new Error("Invalid Gemini safety settings")
    for (const value of payload.safetySettings) {
      const setting = record(value)
      fields(setting, new Set(["category", "threshold"]))
      if (typeof setting.category !== "string" || typeof setting.threshold !== "string")
        throw new Error("Invalid Gemini safety setting")
    }
  }
  const config = payload.generationConfig === undefined ? {} : record(payload.generationConfig)
  validateConfig(config)
  const requested =
    config.maxOutputTokens === undefined ? limits.maxOutputTokens : config.maxOutputTokens
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 16)
    throw new Error("Output token limit must be a safe integer of at least 16")
  const outputTokens = Math.min(
    requested,
    limits.maxOutputTokens,
    limits.mode === "stream" ? 65536 : 32768
  )
  const generation = {
    ...payload,
    serviceTier: "standard",
    generationConfig: {
      ...config,
      maxOutputTokens: outputTokens,
      candidateCount: 1,
      responseModalities: ["TEXT"],
    },
  }
  const messages = payload.contents.length + (payload.systemInstruction === undefined ? 0 : 1)
  return {
    payload: generation,
    body: JSON.stringify(generation),
    outputTokens,
    minimumOutputTokens: 16,
    outputBytes: (tokens) => String(tokens).length,
    withOutputTokens: (tokens) => ({
      ...generation,
      generationConfig: { ...generation.generationConfig, maxOutputTokens: tokens },
    }),
    messages,
    tools: Array.isArray(payload.tools) && payload.tools.length > 0,
  }
}

export function validateRoute(
  request: Request,
  modelId: string,
  mode?: "stream" | "generate"
): void {
  const url = new URL(request.url)
  const match = /\/models\/([^/]+):(generateContent|streamGenerateContent)$/.exec(url.pathname)
  const model = modelId.startsWith("models/") ? modelId.slice(7) : modelId
  if (
    request.method !== "POST" ||
    !match ||
    /\/(projects|publishers|locations|tunedModels)\//.test(url.pathname) ||
    decodeURIComponent(match[1] ?? "") !== model ||
    (mode !== undefined && (match[2] === "streamGenerateContent") !== (mode === "stream")) ||
    (match[2] === "streamGenerateContent" &&
      (url.searchParams.get("alt") !== "sse" || url.searchParams.getAll("alt").length !== 1)) ||
    (match[2] === "generateContent" &&
      url.searchParams.has("alt") &&
      url.searchParams.get("alt") !== "json")
  )
    throw new Error("Unsupported budgeted Gemini route")
}
