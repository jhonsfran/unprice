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
  readonly minimumOutputTokens: number
  /** Serialized bytes of the numeric output settings. All other fields stay fixed. */
  outputBytes(outputTokens: number): number
  /** Resize validated output settings within the prepared request's legal allowance. */
  withOutputTokens(outputTokens: number): object
  /** Messages and tool items in the request, for the per-message overhead of the input bound. */
  readonly messages: number
  /** The request carries tool definitions, so the provider may add its own tool-use prompt. */
  readonly tools: boolean
}
