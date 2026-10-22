export const DEFAULT_BUDGET_TIMEOUT_MS = 10_000

export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  { timeoutMs, signal: callerSignal }: { timeoutMs: number; signal?: AbortSignal }
): Promise<T> {
  const controller = new AbortController()
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = () => aborted.reject(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new DOMException("Budget operation timed out", "TimeoutError")),
    timeoutMs
  )
  try {
    return await Promise.race([operation(signal), aborted.promise])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}
