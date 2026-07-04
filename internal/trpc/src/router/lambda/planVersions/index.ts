import { createTRPCRouter } from "#trpc"
import { applyTemplate } from "./applyTemplate"
import { create } from "./create"
import { deactivate } from "./deactivate"
import { duplicate } from "./duplicate"
import { getById } from "./getById"
import { listByActiveProject } from "./listByActiveProject"
import { listByProjectUnprice } from "./listByProjectUnprice"
import { publish } from "./publish"
import { remove } from "./remove"
import { seedEvidence } from "./seedEvidence"
import { update } from "./update"

export const planVersionRouter = createTRPCRouter({
  applyTemplate: applyTemplate,
  create: create,
  deactivate: deactivate,
  remove: remove,
  update: update,
  duplicate: duplicate,
  publish: publish,
  seedEvidence: seedEvidence,
  getById: getById,
  listByProjectUnprice: listByProjectUnprice,
  listByActiveProject: listByActiveProject,
})
