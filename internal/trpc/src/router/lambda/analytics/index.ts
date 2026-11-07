import { createTRPCRouter } from "#trpc"
import { explainCharge } from "./explainCharge"
import { getBrowserVisits } from "./getBrowserVisits"
import { getCountryVisits } from "./getCountryVisits"
import { getIngestionStatus } from "./getIngestionStatus"
import { getOverviewStats } from "./getOverviewStats"
import { getPagesOverview } from "./getPagesOverview"
import { getPlansConversion } from "./getPlansConversion"
import { getPlansStats } from "./getPlansStats"
import { getRejectedEventPayload } from "./getRejectedEventPayload"
import { getUsage } from "./getUsage"
import { getUsageDashboard } from "./getUsageDashboard"

export const analyticsRouter = createTRPCRouter({
  explainCharge: explainCharge,
  getUsage: getUsage,
  getUsageDashboard: getUsageDashboard,
  getRejectedEventPayload: getRejectedEventPayload,
  getIngestionStatus: getIngestionStatus,
  getBrowserVisits: getBrowserVisits,
  getCountryVisits: getCountryVisits,
  getOverviewStats: getOverviewStats,
  getPlansConversion: getPlansConversion,
  getPlansStats: getPlansStats,
  getPagesOverview: getPagesOverview,
})
