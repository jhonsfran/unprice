import { createTRPCRouter } from "#trpc"
import { assignToPlanVersion } from "./assignToPlanVersion"
import { closeRows } from "./closeRows"
import { create } from "./create"
import { forPlanVersion } from "./forPlanVersion"
import { get } from "./get"
import { list } from "./list"
import { previewCostPlus } from "./previewCostPlus"
import { publishCostPlus } from "./publishCostPlus"
import { publishRows } from "./publishRows"
import { setCatalogPricing } from "./setCatalogPricing"

export const rateCardsRouter = createTRPCRouter({
  assignToPlanVersion,
  closeRows,
  create,
  forPlanVersion,
  get,
  list,
  previewCostPlus,
  publishCostPlus,
  publishRows,
  setCatalogPricing,
})
