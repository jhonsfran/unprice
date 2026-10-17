/** The step runner and assertions every plan-*.ts suite shares. */

export const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

let passedSteps = 0

/** Steps that passed so far. */
export function passed(): number {
  return passedSteps
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Runs one step and prints PASS or FAIL with its duration. A failure rethrows, ending the suite. */
export async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const start = performance.now()

  try {
    await fn()
    passedSteps++
    const ms = (performance.now() - start).toFixed(0)
    console.info(`  ${colors.green("PASS")} ${name} ${colors.dim(`(${ms}ms)`)}`)
  } catch (err) {
    const ms = (performance.now() - start).toFixed(0)
    console.error(
      `  ${colors.red("FAIL")} ${name} ${colors.dim(`(${ms}ms)`)}\n    ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    throw err
  }
}
