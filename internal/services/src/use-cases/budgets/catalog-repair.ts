import type { FetchError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { UnPriceBudgetError } from "../../budgets"

export function isBudgetNotFound(error: FetchError | UnPriceBudgetError): boolean {
  return error instanceof UnPriceBudgetError && error.code === "BUDGET_NOT_FOUND"
}

/** A catalog repair the caller's answer does not depend on: a failure is logged, not returned. */
export async function bestEffort(
  logger: Logger,
  projectId: string,
  repair: () => Promise<void>
): Promise<void> {
  try {
    await repair()
  } catch (error) {
    logger.error(error instanceof Error ? error : new Error(String(error)), {
      context: "budget catalog repair failed",
      projectId,
    })
  }
}
