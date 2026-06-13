import { createTRPCRouter } from "#trpc"
import { explainCharge } from "./explainCharge"
import { getBrowserVisits } from "./getBrowserVisits"
import { getCountryVisits } from "./getCountryVisits"
import { getFailedIngestionEventPayload } from "./getFailedIngestionEventPayload"
import { getIngestionStatus } from "./getIngestionStatus"
import { getLatestEvents } from "./getLatestEvents"
import { getOverviewStats } from "./getOverviewStats"
import { getPagesOverview } from "./getPagesOverview"
import { getPlanClickBySessionId } from "./getPlanClickBySessionId"
import { getPlansConversion } from "./getPlansConversion"
import { getPlansStats } from "./getPlansStats"
import { getUsage } from "./getUsage"
import { getUsageDashboard } from "./getUsageDashboard"
import { replayIngestionEvents } from "./replayIngestionEvents"

export const analyticsRouter = createTRPCRouter({
  explainCharge: explainCharge,
  getUsage: getUsage,
  getUsageDashboard: getUsageDashboard,
  getFailedIngestionEventPayload: getFailedIngestionEventPayload,
  getIngestionStatus: getIngestionStatus,
  getBrowserVisits: getBrowserVisits,
  getCountryVisits: getCountryVisits,
  getOverviewStats: getOverviewStats,
  getPlansConversion: getPlansConversion,
  getPlansStats: getPlansStats,
  getPagesOverview: getPagesOverview,
  getPlanClickBySessionId: getPlanClickBySessionId,
  getLatestEvents: getLatestEvents,
  replayIngestionEvents: replayIngestionEvents,
})
