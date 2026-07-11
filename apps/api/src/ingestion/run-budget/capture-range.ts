import type { OpenRunCaptureIntent, RunCaptureIntent } from "./ports"

export function captureIntentFlushSeq(intent: RunCaptureIntent): number {
  return intent.flushSeq > 0 ? intent.flushSeq : intent.createdAt
}

export function captureIntentRange(intent: RunCaptureIntent): {
  startAmount: number
  targetAmount: number
} {
  if (intent.targetAmount > intent.rangeStartAmount) {
    return {
      startAmount: intent.rangeStartAmount,
      targetAmount: intent.targetAmount,
    }
  }

  const separator = intent.intentKey.lastIndexOf(":")
  const legacyStartAmount = Number(intent.intentKey.slice(separator + 1))
  const startAmount =
    Number.isSafeInteger(legacyStartAmount) && legacyStartAmount >= 0 ? legacyStartAmount : 0

  return { startAmount, targetAmount: startAmount + intent.amount }
}

export function requireCaptureIntentQuantityRange(intent: RunCaptureIntent): OpenRunCaptureIntent {
  if (
    intent.captureQuantity === null ||
    intent.rangeStartQuantity === null ||
    intent.targetQuantity === null
  ) {
    throw new Error(`Run capture intent ${intent.intentKey} has no persisted quantity range`)
  }

  return {
    ...intent,
    captureQuantity: intent.captureQuantity,
    rangeStartQuantity: intent.rangeStartQuantity,
    targetQuantity: intent.targetQuantity,
  }
}
