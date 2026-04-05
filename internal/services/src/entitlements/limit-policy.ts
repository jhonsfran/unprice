import type { OverageStrategy } from "@unprice/db/validators"
import type { Fact } from "./domain"

type LimitPolicyInput = {
  facts: Fact[]
  limit?: number | null
  overageStrategy?: OverageStrategy
}

export function findLimitExceededFact(params: LimitPolicyInput): Fact | null {
  const { facts, overageStrategy = "none", limit } = params

  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return null
  }

  if (overageStrategy === "always") {
    return null
  }

  for (const fact of facts) {
    if (fact.delta <= 0) {
      continue
    }

    if (overageStrategy === "last-call") {
      const previousValue = fact.valueAfter - fact.delta
      if (previousValue >= limit) {
        return fact
      }

      continue
    }

    if (fact.valueAfter > limit) {
      return fact
    }
  }

  return null
}
