import type { BusinessSchema, EntitlementsSchema } from "@unprice/logs"
import type { CloudSchema } from "@unprice/logs"
import type { z } from "zod"
import type { WideEventLogger } from "./wide-events"

/**
 * Helper interface returned by createWideEventHelpers.
 * Provides type-safe methods for adding domain-specific context to wide events.
 */
export interface WideEventHelpers {
  /**
   * Add cloud context to the wide event.
   * @param context - Cloud-related attributes
   */
  addCloud(context: z.infer<typeof CloudSchema>): void

  /**
   * Add business context to the wide event.
   * @param context - Business-related attributes
   */
  addBusiness(context: z.infer<typeof BusinessSchema>): void

  /**
   * Add entitlement context to the wide event.
   * @param context - Entitlement-related attributes
   */
  addEntitlement(context: z.infer<typeof EntitlementsSchema>): void

  /**
   * Add rate limit status to the wide event.
   * @param rateLimited - Whether the request was rate limited
   */
  addRateLimited(rateLimited: boolean): void

  /**
   * Add tRPC error code to the wide event.
   * @param code - The tRPC error code (e.g., "UNAUTHORIZED", "BAD_REQUEST")
   */
  addTrpcErrorCode(code: string): void

  /**
   * Add request route pattern to the wide event.
   * @param route - The matched route pattern (e.g., "/api/customers/:id")
   */
  addRoute(route: string): void

  /**
   * Add parent request ID for correlating child operations (e.g., DO calls).
   * @param parentId - The parent request ID
   */
  addParentRequestId(parentId: string): void

  /**
   * Check if the helpers have a valid logger instance.
   */
  hasLogger(): boolean
}

/**
 * Creates helper functions for consistent context enrichment of wide events.
 *
 * This factory provides a type-safe, standardized API for adding domain-specific
 * context to wide events. It safely handles cases where the logger is null/undefined.
 *
 * @param logger - The WideEventLogger instance (or null/undefined)
 * @returns Helper functions for adding context
 *
 * @example
 * ```ts
 * // In your middleware or service
 * const helpers = createWideEventHelpers(ctx.wideEventLogger)
 *
 * helpers.addBusiness({
 *   project_id: project.id,
 *   workspace_id: workspace.id,
 *   is_main: project.isMain,
 * })
 *
 * helpers.addEntitlement({
 *   allowed: true,
 *   feature_type: "usage",
 *   usage: 150,
 *   limit: 1000,
 * })
 * ```
 */
export function createWideEventHelpers(
  logger: WideEventLogger | null | undefined
): WideEventHelpers {
  return {
    addCloud(context: z.infer<typeof CloudSchema>): void {
      if (!logger) return
      logger.addMany({ cloud: context })
    },

    addBusiness(context: z.infer<typeof BusinessSchema>): void {
      if (!logger) return
      logger.addMany({ business: context })
    },

    addEntitlement(context: z.infer<typeof EntitlementsSchema>): void {
      if (!logger) return
      logger.addMany({ entitlements: context })
    },

    addRateLimited(rateLimited: boolean): void {
      if (!logger) return
      logger.add("request.rate_limited", rateLimited)
    },

    addTrpcErrorCode(code: string): void {
      if (!logger) return
      logger.add("error.trpc_code", code)
    },

    addRoute(route: string): void {
      if (!logger) return
      logger.add("request.route", route)
    },

    addParentRequestId(parentId: string): void {
      if (!logger) return
      logger.add("request.parent_id", parentId)
    },

    hasLogger(): boolean {
      return logger !== null && logger !== undefined
    },
  }
}
