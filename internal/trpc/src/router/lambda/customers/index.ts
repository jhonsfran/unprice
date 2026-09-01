import { createTRPCRouter } from "#trpc"
import { create } from "./create"
import { createPaymentMethodByActiveProject } from "./createPaymentMethodByActiveProject"
import { exist } from "./exist"
import { getByEmail } from "./getByEmail"
import { getById } from "./getById"
import { getByIdActiveProject } from "./getByIdActiveProject"
import { getCurrentAccess } from "./getCurrentAccess"
import { getCurrentEntitlements } from "./getCurrentEntitlements"
import { getEconomicSummary } from "./getEconomicSummary"
import { getEntitlements } from "./getEntitlements"
import { getInvoiceById } from "./getInvoiceById"
import { getInvoices } from "./getInvoices"
import { getRuns } from "./getRuns"
import { getSubscription } from "./getSubscription"
import { getSubscriptions } from "./getSubscriptions"
import { getWallet } from "./getWallet"
import { listByActiveProject } from "./listByActiveProject"
import { listPaymentMethodsByActiveProject } from "./listPaymentMethodsByActiveProject"
import { listRunsByActiveProject } from "./listRunsByActiveProject"
import { remove } from "./remove"
import { update } from "./update"

export const customersRouter = createTRPCRouter({
  create: create,
  createPaymentMethodByActiveProject: createPaymentMethodByActiveProject,
  remove: remove,
  update: update,
  exist: exist,
  getByEmail: getByEmail,
  getById: getById,
  getByIdActiveProject: getByIdActiveProject,
  getCurrentAccess: getCurrentAccess,
  getCurrentEntitlements: getCurrentEntitlements,
  getEconomicSummary: getEconomicSummary,
  getEntitlements: getEntitlements,
  getSubscription: getSubscription,
  getSubscriptions: getSubscriptions,
  listByActiveProject: listByActiveProject,
  listPaymentMethodsByActiveProject: listPaymentMethodsByActiveProject,
  listRunsByActiveProject: listRunsByActiveProject,
  getInvoices: getInvoices,
  getRuns: getRuns,
  getWallet: getWallet,
  getInvoiceById: getInvoiceById,
})
