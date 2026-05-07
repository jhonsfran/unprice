import { createTRPCRouter } from "#trpc"
import { disconnectConnection } from "./disconnectConnection"
import { getConfig } from "./getConfig"
import { getConnection } from "./getConnection"
import { refreshConnection } from "./refreshConnection"
import { saveConfig } from "./saveConfig"
import { startConnection } from "./startConnection"

export const paymentProviderRouter = createTRPCRouter({
  saveConfig: saveConfig,
  getConfig: getConfig,
  startConnection,
  refreshConnection,
  getConnection,
  disconnectConnection,
})
