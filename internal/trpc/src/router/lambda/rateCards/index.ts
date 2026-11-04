import { createTRPCRouter } from "#trpc"
import { assignToPlanVersion } from "./assignToPlanVersion"
import { closeRows } from "./closeRows"
import { create } from "./create"
import { get } from "./get"
import { list } from "./list"
import { previewCostPlus } from "./previewCostPlus"
import { publishCostPlus } from "./publishCostPlus"
import { publishRows } from "./publishRows"

export const rateCardsRouter = createTRPCRouter({
  assignToPlanVersion,
  closeRows,
  create,
  get,
  list,
  previewCostPlus,
  publishCostPlus,
  publishRows,
})
