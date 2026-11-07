import { createTRPCRouter } from "#trpc"
import { create } from "./create"
import { createWithDraft } from "./createWithDraft"
import { exist } from "./exist"
import { getById } from "./getById"
import { getBySlug } from "./getBySlug"
import { getSubscriptionsBySlug } from "./getSubscriptionsBySlug"
import { getVersionsBySlug } from "./getVersionsBySlug"
import { listByActiveProject } from "./listByActiveProject"
import { remove } from "./remove"
import { update } from "./update"

export const planRouter = createTRPCRouter({
  create: create,
  createWithDraft,
  remove: remove,
  update: update,
  exist: exist,
  getBySlug: getBySlug,
  getVersionsBySlug: getVersionsBySlug,
  getSubscriptionsBySlug: getSubscriptionsBySlug,
  getById: getById,
  listByActiveProject: listByActiveProject,
})
