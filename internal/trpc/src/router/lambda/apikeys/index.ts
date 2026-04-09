import { createTRPCRouter } from "#trpc"
import { bindCustomer } from "./bindCustomer"
import { create } from "./create"
import { listByActiveProject } from "./listByActiveProject"
import { revoke } from "./revoke"
import { roll } from "./roll"
import { unbindCustomer } from "./unbindCustomer"

export const apiKeyRouter = createTRPCRouter({
  listByActiveProject: listByActiveProject,
  create: create,
  revoke: revoke,
  roll: roll,
  bindCustomer: bindCustomer,
  unbindCustomer: unbindCustomer,
})
