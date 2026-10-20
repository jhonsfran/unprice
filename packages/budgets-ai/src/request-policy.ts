export type BudgetProtocol = "openai-responses" | "anthropic-messages" | "google-generative-ai"

/** The model's context and output limits, as the catalog row carries them. */
export interface ModelLimits {
  context: number
  output: number
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
  /** Messages and tool items in the request, for the per-message overhead of the input bound. */
  readonly messages: number
}
