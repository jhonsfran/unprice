import type { Unprice } from "@unprice/api"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { ServiceContext } from "../../context"

/**
 * The Budgets page's "Create a test budget": one sandbox budget with a small daily hard cap, one
 * charge that fits and one that would cross it. It goes through the public API with a short-lived
 * runtime key, the same path a builder's code takes, so the 402 it shows is the real enforcement.
 *
 * Every call is idempotent within a UTC day: the upsert sends the same definition, and both
 * charges carry that day's idempotency keys, so a second click replays the same two decisions
 * instead of spending again. The daily window resets the cap, so tomorrow's click starts fresh.
 */
export const TEST_BUDGET_KEY = "sandbox:test-budget"
export const TEST_BUDGET_API_KEY_NAME = "Budgets test (sandbox)"
export const TEST_BUDGET_CAP = "10"
export const TEST_BUDGET_ALLOWED_AMOUNT = "4"
export const TEST_BUDGET_DENIED_AMOUNT = "8"
const TEST_BUDGET_API_KEY_TTL_MS = 60 * 60 * 1000

export const runTestBudgetInputSchema = z.object({
  projectId: z.string().min(1),
  workspaceIsMain: z.boolean().default(false),
  now: z.number().int().optional(),
})

const testBudgetBalanceSchema = z.object({
  remaining: z.string().nullable(),
})

export const runTestBudgetOutputSchema = z.object({
  key: z.string(),
  unit: z.string(),
  cap: z.string(),
  window: z.literal("day"),
  allowed: z.object({
    amount: z.string(),
    remaining: z.string().nullable(),
  }),
  denied: z.object({
    amount: z.string(),
    status: z.literal(402),
    code: z.literal("BUDGET_EXCEEDED"),
    message: z.string(),
    remaining: z.string().nullable(),
  }),
})

export type RunTestBudgetInput = z.input<typeof runTestBudgetInputSchema>
export type RunTestBudgetOutput = z.infer<typeof runTestBudgetOutputSchema>

type TestBudgetApi = { budgets: Pick<Unprice["budgets"], "upsert" | "charge"> }

export type RunTestBudgetDeps = {
  services: Pick<ServiceContext, "apikeys">
  logger: Logger
  createApiClient: (token: string) => TestBudgetApi
}

function testBudgetError(message: string) {
  return new FetchError({ message, retry: false })
}

/** The `details.balance.remaining` of a 402, when the API sent it. */
function remainingOf(details: unknown): string | null {
  const parsed = z.object({ balance: testBudgetBalanceSchema }).safeParse(details)
  return parsed.success ? parsed.data.balance.remaining : null
}

export async function runTestBudget(
  deps: RunTestBudgetDeps,
  rawInput: RunTestBudgetInput
): Promise<Result<RunTestBudgetOutput, FetchError>> {
  const input = runTestBudgetInputSchema.parse(rawInput)
  const now = input.now ?? Date.now()
  const day = new Date(now).toISOString().slice(0, 10)

  deps.logger.set({
    business: { operation: "budgets.run-test-budget", project_id: input.projectId },
  })

  // A runtime key, like the one the setup hands a builder: it can create and tighten a budget,
  // never raise one. It lives an hour and is rolled on the next click, so it is never reused.
  const apiKeyResult = await deps.services.apikeys.createOrRollApiKey({
    projectId: input.projectId,
    name: TEST_BUDGET_API_KEY_NAME,
    isRoot: input.workspaceIsMain,
    defaultCustomerId: null,
    expiresAt: now + TEST_BUDGET_API_KEY_TTL_MS,
  })
  if (apiKeyResult.err) {
    return Err(testBudgetError(`Test key setup failed: ${apiKeyResult.err.message}`))
  }

  const api = deps.createApiClient(apiKeyResult.val.key)

  const upserted = await api.budgets.upsert({
    key: TEST_BUDGET_KEY,
    unit: "USD",
    limits: [{ amount: TEST_BUDGET_CAP, window: "day" }],
  })
  if (upserted.error) {
    return Err(testBudgetError(`The test budget could not be created: ${upserted.error.message}`))
  }

  const allowed = await api.budgets.charge({
    key: TEST_BUDGET_KEY,
    amount: TEST_BUDGET_ALLOWED_AMOUNT,
    idempotencyKey: `test-budget:${day}:allowed`,
  })
  if (allowed.error) {
    return Err(testBudgetError(`The first test spend was not allowed: ${allowed.error.message}`))
  }

  const denied = await api.budgets.charge({
    key: TEST_BUDGET_KEY,
    amount: TEST_BUDGET_DENIED_AMOUNT,
    idempotencyKey: `test-budget:${day}:denied`,
  })
  if (!denied.error) {
    return Err(testBudgetError("The spend over the cap was allowed; the cap did not hold."))
  }
  if (denied.error.code !== "BUDGET_EXCEEDED") {
    return Err(testBudgetError(`The second test spend failed: ${denied.error.message}`))
  }

  return Ok(
    runTestBudgetOutputSchema.parse({
      key: TEST_BUDGET_KEY,
      unit: "USD",
      cap: TEST_BUDGET_CAP,
      window: "day",
      allowed: {
        amount: allowed.result.amount,
        remaining: allowed.result.balance.remaining,
      },
      denied: {
        amount: TEST_BUDGET_DENIED_AMOUNT,
        status: 402,
        code: "BUDGET_EXCEEDED",
        message: denied.error.message,
        remaining: remainingOf("details" in denied.error ? denied.error.details : undefined),
      },
    })
  )
}
