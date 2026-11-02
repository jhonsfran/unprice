import { createTRPCRouter } from "#trpc"
import { audit } from "./audit"
import { createTestBudget } from "./createTestBudget"
import { get } from "./get"
import { inspect } from "./inspect"
import { list } from "./list"
import { openByKey } from "./openByKey"
import { releaseHold } from "./releaseHold"

export const budgetsRouter = createTRPCRouter({
  audit,
  createTestBudget,
  get,
  inspect,
  list,
  openByKey,
  releaseHold,
})
