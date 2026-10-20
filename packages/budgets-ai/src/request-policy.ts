export type BudgetProtocol = "openai-responses" | "anthropic-messages" | "google-generative-ai"

/** Provider-enforced model limits. These must match the endpoint and selected model. */
export interface ModelLimits {
  maxInputTokens: number
  maxOutputTokens: number
}

export interface RequestLimits {
  modelId: string
  maxOutputTokens: number
  mode: "stream" | "generate"
}

export interface PreparedRequest {
  readonly payload: object
  readonly body: string
  readonly outputTokens: number
}
