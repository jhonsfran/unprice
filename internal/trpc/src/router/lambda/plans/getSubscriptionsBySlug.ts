import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { and, desc, eq, getTableColumns } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import {
  customerSelectSchema,
  planSelectBaseSchema,
  projectExtendedSelectSchema,
  subscriptionSelectSchema,
} from "@unprice/db/validators"

import { FEATURE_SLUGS } from "@unprice/config"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

export const getSubscriptionsBySlug = protectedProjectProcedure
  .input(z.object({ slug: z.string() }))
  .output(
    z.object({
      plan: planSelectBaseSchema,
      subscriptions: subscriptionSelectSchema
        .extend({
          customer: customerSelectSchema,
        })
        .array(),
      project: projectExtendedSelectSchema,
    })
  )
  .query(async (opts) => {
    const { slug } = opts.input
    const project = opts.ctx.project
    const customerColumns = getTableColumns(schema.customers)
    const workspace = opts.ctx.project.workspace
    const customerId = workspace.unPriceCustomerId
    const featureSlug = FEATURE_SLUGS.PLANS.SLUG

    const result = await featureGuard({
      customerId,
      featureSlug,
      isMain: workspace.isMain,
      metadata: {
        action: "getSubscriptionsBySlug",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const plan = await opts.ctx.db.query.plans.findFirst({
      where: (plan, { eq, and }) => and(eq(plan.slug, slug), eq(plan.projectId, project.id)),
    })

    if (!plan) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Plan not found",
      })
    }

    const planWithSubscriptions = await opts.ctx.db
      .selectDistinctOn([schema.subscriptions.id], {
        subscriptions: schema.subscriptions,
        customer: customerColumns,
      })
      .from(schema.plans)
      .innerJoin(
        schema.versions,
        and(
          eq(schema.versions.planId, schema.plans.id),
          eq(schema.versions.projectId, schema.plans.projectId)
        )
      )
      .innerJoin(
        schema.subscriptionPhases,
        and(
          eq(schema.versions.id, schema.subscriptionPhases.planVersionId),
          eq(schema.versions.projectId, schema.subscriptionPhases.projectId)
        )
      )
      .innerJoin(
        schema.subscriptions,
        and(
          eq(schema.subscriptions.id, schema.subscriptionPhases.subscriptionId),
          eq(schema.subscriptions.projectId, schema.subscriptionPhases.projectId)
        )
      )
      .innerJoin(
        schema.customers,
        and(
          eq(schema.customers.id, schema.subscriptions.customerId),
          eq(schema.customers.projectId, schema.subscriptions.projectId)
        )
      )
      .where(and(eq(schema.plans.slug, slug), eq(schema.plans.projectId, project.id)))
      .orderBy(() => [desc(schema.subscriptions.id)])

    if (!planWithSubscriptions || !planWithSubscriptions.length) {
      return {
        plan: plan,
        project: project,
        subscriptions: [],
      }
    }

    const subscriptions = planWithSubscriptions.map((data) => {
      return {
        ...data.subscriptions,
        customer: data.customer,
      }
    })

    return {
      plan: plan,
      project: project,
      subscriptions: subscriptions,
    }
  })
