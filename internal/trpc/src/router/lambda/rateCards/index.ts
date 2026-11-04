import { createTRPCRouter } from "#trpc"
import { create } from "./create"
import { get } from "./get"
import { list } from "./list"
import { previewCostPlus } from "./previewCostPlus"
import { publishCostPlus } from "./publishCostPlus"
import { publishRows } from "./publishRows"

export const rateCardsRouter = createTRPCRouter({
  create,
  get,
  list,
  previewCostPlus,
  publishCostPlus,
  publishRows,
})
