/** Tokens a chat template can add around the whole request: role markers, separators, framing. */
export const REQUEST_OVERHEAD_TOKENS = 32
/** Tokens a chat template can add around one message or tool item. */
export const MESSAGE_OVERHEAD_TOKENS = 8

const encoder = new TextEncoder()

/**
 * A count the request's input tokens cannot exceed, with no call to the provider. Byte-level BPE
 * and byte-fallback SentencePiece tokenizers emit at least one byte per token, so the UTF-8 length
 * of the serialized body bounds its tokens; the overheads cover what the chat template adds. The
 * JSON syntax in the body only loosens the bound.
 */
export function inputBound(body: string, messages: number): number {
  if (!Number.isSafeInteger(messages) || messages < 0)
    throw new Error("Invalid message count for the input bound")
  return encoder.encode(body).length + MESSAGE_OVERHEAD_TOKENS * messages + REQUEST_OVERHEAD_TOKENS
}
