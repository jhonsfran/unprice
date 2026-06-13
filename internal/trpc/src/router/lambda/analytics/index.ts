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
import { getProjectUsage } from "./getProjectUsage"
import { getProjectUsageTimeseries } from "./getProjectUsageTimeseries"
import { getTopConsumers } from "./getTopConsumers"
import { getUsage } from "./getUsage"
import { replayIngestionEvents } from "./replayIngestionEvents"

export const analyticsRouter = createTRPCRouter({
  explainCharge: explainCharge,
  getUsage: getUsage,
  getProjectUsage: getProjectUsage,
  getProjectUsageTimeseries: getProjectUsageTimeseries,
  getFailedIngestionEventPayload: getFailedIngestionEventPayload,
  getIngestionStatus: getIngestionStatus,
  getTopConsumers: getTopConsumers,
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
