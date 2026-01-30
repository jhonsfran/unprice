import { TRPCError } from "@trpc/server"
import {
  planSelectBaseSchema,
  planVersionSelectBaseSchema,
  projectExtendedSelectSchema,
} from "@unprice/db/validators"
import { z } from "zod"

import { FEATURE_SLUGS } from "@unprice/config"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

export const getVersionsBySlug = protectedProjectProcedure
  .input(z.object({ slug: z.string() }))
  .output(
    z.object({
      plan: planSelectBaseSchema.extend({
        versions: z.array(
          planVersionSelectBaseSchema.extend({
            subscriptions: z.number(),
            plan: planSelectBaseSchema.pick({ defaultPlan: true }),
          })
        ),
      }),
      project: projectExtendedSelectSchema,
    })
  )
  .query(async (opts) => {
    const { slug } = opts.input
    const project = opts.ctx.project

    const workspace = opts.ctx.project.workspace
    const customerId = workspace.unPriceCustomerId
    const featureSlug = FEATURE_SLUGS.PLANS.SLUG

    const result = await featureGuard({
      customerId,
      featureSlug,
      metadata: {
        action: "getVersionsBySlug",
      },
      isMain: workspace.isMain,
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    // TODO: better rewrite this query to use joins instead of subqueries
    const planWithVersions = await opts.ctx.db.query.plans
      .findFirst({
        with: {
          versions: {
            orderBy: (version, { desc }) => [desc(version.createdAtM)],
            with: {
              phases: {
                columns: {
                  id: true,
                  subscriptionId: true,
                },
              },
              plan: {
                columns: {
                  defaultPlan: true,
                },
              },
            },
          },
        },
        where: (plan, { eq, and }) => and(eq(plan.slug, slug), eq(plan.projectId, project.id)),
      })
      .then((plans) => {
        return (
          plans && {
            ...plans,
            versions: plans.versions.map((version) => ({
              ...version,
              // TODO: fix this, we should count the number of subscriptions per plan version
              subscriptions: version.phases.length,
            })),
          }
        )
      })

    if (!planWithVersions) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Plan not found",
      })
    }

    return {
      plan: planWithVersions,
      project: project,
    }
  })
