import { OpenAPIHono } from "@hono/zod-openapi"
import { Err } from "@unprice/error"
import { type BudgetRejection, UnPriceBudgetError } from "@unprice/services/budgets"
import { expect, it, vi } from "vitest"
import { handleError, handleZodError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

const mocks = vi.hoisted(() => ({ sync: vi.fn(), seal: vi.fn(), complete: vi.fn() }))
vi.mock("@unprice/services/use-cases", async (original) => ({
  ...(await original<typeof import("@unprice/services/use-cases")>()),
  syncPayerBudget: mocks.sync,
  sealPayerStatements: mocks.seal,
  completeInvoicedPayerStatements: mocks.complete,
}))
vi.mock("~/ingestion/budget/payer-budget-sync", () => ({ payerBudgetSyncDeps: () => ({}) }))
import { registerCompletePayerStatementsInternalV1 } from "./completePayerStatementsInternalV1"
import { registerSealPayerStatementsInternalV1 } from "./sealPayerStatementsInternalV1"
import { registerSyncPayerBudgetInternalV1 } from "./syncPayerBudgetInternalV1"

const rejections: BudgetRejection[] = [
  { code: "STATEMENT_OVERLAP", periodId: "bp_1", overlaps: "bp_2" },
  { code: "CARD_INCOMPATIBLE", cardId: "card_1", violations: [] },
  { code: "STATEMENT_NOT_SEALED", periodId: "bp_1" },
]

it.each(
  ["sync", "seal", "complete"].flatMap((operation) =>
    rejections.map((rejection) => ({ operation, rejection }))
  )
)("maps $operation $rejection.code to 409", async ({ operation, rejection }) => {
  const rejected = Err(new UnPriceBudgetError(rejection))
  mocks.sync.mockResolvedValue(rejected)
  mocks.seal.mockResolvedValue(rejected)
  mocks.complete.mockResolvedValue(rejected)
  const app = new OpenAPIHono<HonoEnv>({ defaultHook: handleZodError })
  app.onError(handleError)
  app.use("*", async (c, next) => {
    c.set("services", {} as HonoEnv["Variables"]["services"])
    c.set("requestId", "req_test")
    c.set("logger", { set: vi.fn(), error: vi.fn() } as unknown as HonoEnv["Variables"]["logger"])
    await next()
  })
  registerSyncPayerBudgetInternalV1(app)
  registerSealPayerStatementsInternalV1(app)
  registerCompletePayerStatementsInternalV1(app)
  const response = await app.request(`/v1/internal/payer-budgets/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: "proj_test",
      customerId: "cus_test",
      statementKey: "stmt_test",
      at: 1,
    }),
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: "CONFLICT" } })
})
