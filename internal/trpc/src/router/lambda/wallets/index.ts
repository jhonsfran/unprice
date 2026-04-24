import { createTRPCRouter } from "#trpc"
import { initiateTopup } from "./initiateTopup"

export const walletsRouter = createTRPCRouter({
  initiateTopup: initiateTopup,
})
