import { createTRPCRouter } from "#trpc"
import { list } from "./list"

export const budgetsRouter = createTRPCRouter({
  list,
})
