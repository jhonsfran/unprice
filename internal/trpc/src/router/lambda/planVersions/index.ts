import { createTRPCRouter } from "#trpc"
import { create } from "./create"
import { deactivate } from "./deactivate"
import { duplicate } from "./duplicate"
import { getById } from "./getById"
import { listByActiveProject } from "./listByActiveProject"
import { listByProjectUnprice } from "./listByProjectUnprice"
import { provePaidAction } from "./provePaidAction"
import { publish } from "./publish"
import { remove } from "./remove"
import { update } from "./update"

export const planVersionRouter = createTRPCRouter({
  create: create,
  deactivate: deactivate,
  remove: remove,
  update: update,
  duplicate: duplicate,
  publish: publish,
  provePaidAction: provePaidAction,
  getById: getById,
  listByProjectUnprice: listByProjectUnprice,
  listByActiveProject: listByActiveProject,
})
