import { expect } from "vitest"

export async function expectEventually<T>({
  read,
  assert,
  timeoutMs = 2_000,
  intervalMs = 25,
}: {
  read: () => Promise<T>
  assert: (value: T) => void | Promise<void>
  timeoutMs?: number
  intervalMs?: number
}) {
  const deadline = Date.now() + timeoutMs
  let lastValue: T | undefined
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      lastValue = await read()
      await assert(lastValue)
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  expect({
    lastValue,
    lastError: lastError instanceof Error ? lastError.message : String(lastError),
  }).toEqual({ converged: true })
}
