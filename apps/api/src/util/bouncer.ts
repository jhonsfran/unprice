import type { Context } from "hono"
import { endTime, startTime } from "hono/timing"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

/**
 * Bouncer checks if the customer is blocked by the usage limiter
 * @param c - The context
 * @param customerId - The customer ID
 * @param projectId - The project ID
 * @returns True if the customer is blocked, false otherwise
 */
export const bouncer = async (c: Context<HonoEnv>, customerId: string, projectId: string) => {
  const { usagelimiter } = c.get("services")

  startTime(c, "bouncer")

  // Check access control list in cache (Edge-cached, ~0-10ms latency)
  const acl = await usagelimiter.getAccessControlList({
    customerId,
    projectId,
    now: Date.now(),
  })

  endTime(c, "bouncer")

  if (acl?.customerDisabled) {
    throw new UnpriceApiError({
      code: "FORBIDDEN",
      message: "Your account has been disabled. Please contact support.",
    })
  }

  if (acl?.subscriptionStatus === "past_due") {
    throw new UnpriceApiError({
      code: "FORBIDDEN",
      message: "You have an outstanding invoice. Please pay to continue using the API.",
    })
  }

  if (acl?.customerUsageLimitReached) {
    throw new UnpriceApiError({
      code: "FORBIDDEN",
      message: "Your UnPrice API limit has been reached. Please upgrade to continue.",
    })
  }
}
