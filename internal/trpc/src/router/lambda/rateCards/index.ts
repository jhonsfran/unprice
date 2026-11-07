import { createTRPCRouter } from "#trpc"
import { applyCatalogPricing } from "./applyCatalogPricing"
import { assignToPlanVersion } from "./assignToPlanVersion"
import { closeRows } from "./closeRows"
import { create } from "./create"
import { addCustomModel, listCustomModels } from "./customModels"
import { forPlanVersion } from "./forPlanVersion"
import { get } from "./get"
import { list } from "./list"
import { previewCatalogPricing } from "./previewCatalogPricing"
import { previewCostPlus } from "./previewCostPlus"
import { publishCostPlus } from "./publishCostPlus"
import { publishRows } from "./publishRows"

export const rateCardsRouter = createTRPCRouter({
  addCustomModel,
  assignToPlanVersion,
  closeRows,
  create,
  forPlanVersion,
  get,
  list,
  listCustomModels,
  previewCostPlus,
  publishCostPlus,
  publishRows,
  previewCatalogPricing,
  applyCatalogPricing,
})
