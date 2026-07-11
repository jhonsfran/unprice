import { expect, it } from "vitest"
import { serializeRunBudgetApply } from "./apply-serialization"

it("serializes concurrent RunBudget apply forwarding", async () => {
  let gate = Promise.resolve()
  const state = {
    blockConcurrencyWhile: async <T>(callback: () => Promise<T> | T): Promise<T> => {
      const previous = gate
      let release: () => void = () => undefined
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      try {
        return await callback()
      } finally {
        release()
      }
    },
  }
  let calls = 0
  let releaseFirst: () => void = () => undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const apply = async () => {
    calls++
    if (calls === 1) await firstGate
    return calls
  }

  const first = serializeRunBudgetApply(state, apply)
  await Promise.resolve()
  const second = serializeRunBudgetApply(state, apply)
  await Promise.resolve()
  expect(calls).toBe(1)
  releaseFirst()
  await Promise.all([first, second])
  expect(calls).toBe(2)
})
