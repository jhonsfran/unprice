import type { BudgetProtocol } from "./request-policy"

export interface StreamUsageEvidence {
  observe(raw: unknown): void
  readonly isComplete: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function tokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function googleEvidence(): StreamUsageEvidence {
  let terminal: string | undefined
  let finalUsage:
    | { input: number; output: number; thinking: number; cache: number; total: number }
    | undefined
  let invalid = false
  return {
    get isComplete() {
      return finalUsage !== undefined && !invalid
    },
    observe(raw) {
      const chunk = record(raw)
      if (!chunk || chunk.error !== undefined) {
        invalid = true
        return
      }
      const candidates = chunk.candidates
      if (candidates !== undefined && (!Array.isArray(candidates) || candidates.length > 1)) {
        invalid = true
        return
      }
      const candidate = Array.isArray(candidates) ? record(candidates[0]) : undefined
      if (candidate?.continuationToken !== undefined) {
        invalid = true
        return
      }
      const content = record(candidate?.content)
      if (terminal && Array.isArray(content?.parts) && content.parts.length > 0) {
        invalid = true
        return
      }
      const reason = candidate?.finishReason
      if (reason !== undefined) {
        if (
          typeof reason !== "string" ||
          reason.length === 0 ||
          (terminal && reason !== terminal)
        ) {
          invalid = true
          return
        }
        terminal = reason
      }
      if (!terminal || chunk.usageMetadata === undefined) return
      const usage = record(chunk.usageMetadata)
      const input = usage?.promptTokenCount
      const output = usage?.candidatesTokenCount
      const thinking = usage?.thoughtsTokenCount ?? 0
      const cache = usage?.cachedContentTokenCount ?? 0
      const total = usage?.totalTokenCount
      if (
        !tokens(input) ||
        !tokens(output) ||
        !tokens(thinking) ||
        !tokens(cache) ||
        !tokens(total) ||
        cache > input ||
        total !== input + output + thinking ||
        (usage?.toolUsePromptTokenCount !== undefined && usage.toolUsePromptTokenCount !== 0)
      ) {
        invalid = true
        return
      }
      if (
        finalUsage &&
        (input < finalUsage.input ||
          output < finalUsage.output ||
          thinking < finalUsage.thinking ||
          cache < finalUsage.cache ||
          total < finalUsage.total)
      ) {
        invalid = true
        return
      }
      finalUsage = { input, output, thinking, cache, total }
    },
  }
}

function anthropicEvidence(): StreamUsageEvidence {
  type State =
    | { phase: "ready" | "content" | "complete" | "invalid" }
    | { phase: "deltas"; output: number; reason: string | undefined }
  let state: State = { phase: "ready" }
  return {
    get isComplete() {
      return state.phase === "complete"
    },
    observe(raw) {
      if (state.phase === "invalid") return
      const event = record(raw)
      if (!event || typeof event.type !== "string") {
        state = { phase: "invalid" }
        return
      }
      if (event.type === "ping") return
      switch (event.type) {
        case "message_start": {
          const usage = record(record(event.message)?.usage)
          if (
            state.phase !== "ready" ||
            !tokens(usage?.input_tokens) ||
            !tokens(usage?.cache_creation_input_tokens ?? 0) ||
            !tokens(usage?.cache_read_input_tokens ?? 0)
          ) {
            state = { phase: "invalid" }
            return
          }
          state = { phase: "content" }
          break
        }
        case "message_delta": {
          if (state.phase !== "content" && state.phase !== "deltas") {
            state = { phase: "invalid" }
            return
          }
          const reason = record(event.delta)?.stop_reason
          const output = record(event.usage)?.output_tokens
          const previous = state.phase === "deltas" ? state : undefined
          if (
            !tokens(output) ||
            output < (previous?.output ?? 0) ||
            (reason !== undefined &&
              reason !== null &&
              (typeof reason !== "string" ||
                reason.length === 0 ||
                (previous?.reason && reason !== previous.reason)))
          ) {
            state = { phase: "invalid" }
            return
          }
          state = {
            phase: "deltas",
            output,
            reason: typeof reason === "string" ? reason : previous?.reason,
          }
          break
        }
        case "message_stop":
          state = { phase: state.phase === "deltas" && state.reason ? "complete" : "invalid" }
          break
        case "content_block_start":
        case "content_block_delta":
        case "content_block_stop":
          if (state.phase !== "content") state = { phase: "invalid" }
          break
        default:
          state = { phase: "invalid" }
      }
    },
  }
}

/** Confirm final raw usage before a native SDK's finish event can release a reservation. */
export function createStreamUsageEvidence(
  protocol: Exclude<BudgetProtocol, "openai-responses">
): StreamUsageEvidence {
  return protocol === "anthropic-messages" ? anthropicEvidence() : googleEvidence()
}
