import { createTRPCRouter } from "#trpc"
import { closeRows } from "./closeRows"
import { create } from "./create"
import { get } from "./get"
import { list } from "./list"
import { previewCostPlus } from "./previewCostPlus"
import { publishCostPlus } from "./publishCostPlus"
import { publishRows } from "./publishRows"

export const rateCardsRouter = createTRPCRouter({
  closeRows,
  create,
  get,
  list,
  previewCostPlus,
  publishCostPlus,
  publishRows,
})
