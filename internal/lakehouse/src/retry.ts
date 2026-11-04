import type { BaseError, Result } from "@unprice/error"

export type RetryPolicy = {
  /** Attempts after the first. */
  retries: number
  /** Delay before the first retry; each later retry doubles it. */
  backoffMs: number
}

/** Runs `attempt` again, with exponential backoff, while it fails with an error flagged `retry`. */
export async function withRetries<T, E extends BaseError & { retry: boolean }>(
  attempt: () => Promise<Result<T, E>>,
  policy: RetryPolicy
): Promise<Result<T, E>> {
  let result = await attempt()
  for (let retry = 0; retry < policy.retries && result.err?.retry; retry++) {
    if (policy.backoffMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, policy.backoffMs * 2 ** retry))
    }
    result = await attempt()
  }
  return result
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
}
