import { createTRPCRouter } from "#trpc"
import { get } from "./get"
import { inspect } from "./inspect"
import { list } from "./list"
import { openByKey } from "./openByKey"

export const budgetsRouter = createTRPCRouter({
  get,
  inspect,
  list,
  openByKey,
})
