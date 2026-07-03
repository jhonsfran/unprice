import { createTRPCRouter } from "#trpc"
import { bindCustomer } from "./bindCustomer"
import { create } from "./create"
import { listByActiveProject } from "./listByActiveProject"
import { revoke } from "./revoke"
import { roll } from "./roll"
import { rollDefaultSdkExample } from "./rollDefaultSdkExample"
import { unbindCustomer } from "./unbindCustomer"

export const apiKeyRouter = createTRPCRouter({
  listByActiveProject: listByActiveProject,
  create: create,
  revoke: revoke,
  roll: roll,
  rollDefaultSdkExample: rollDefaultSdkExample,
  bindCustomer: bindCustomer,
  unbindCustomer: unbindCustomer,
})
