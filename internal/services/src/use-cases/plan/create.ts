import type { Database } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { InsertPlan, Plan } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"

type CreatePlanDeps = {
  services: Pick<ServiceContext, "plans">
  db: Database
  logger: Logger
}

type CreatePlanInput = {
  input: InsertPlan
  projectId: string
}

export async function createPlan(
  deps: CreatePlanDeps,
  params: CreatePlanInput
): Promise<Result<Plan, FetchError>> {
  const { db, logger } = deps
  const { input, projectId } = params
  const { slug, description, defaultPlan, enterprisePlan, title } = input

  logger.set({
    business: {
      operation: "plan.create",
      project_id: projectId,
    },
  })

  if (defaultPlan && enterprisePlan) {
    return Err(
      new FetchError({
        message: "A plan cannot be both a default and enterprise plan",
        retry: false,
      })
    )
  }

  if (defaultPlan) {
    const existing = await db.query.plans.findFirst({
      where: (plan, { eq, and }) => and(eq(plan.projectId, projectId), eq(plan.defaultPlan, true)),
    })

    if (existing?.id) {
      return Err(
        new FetchError({
          message: "There is already a default plan for this app",
          retry: false,
        })
      )
    }
  }

  if (enterprisePlan) {
    const existing = await db.query.plans.findFirst({
      where: (plan, { eq, and }) =>
        and(eq(plan.projectId, projectId), eq(plan.enterprisePlan, true)),
    })

    if (existing?.id) {
      return Err(
        new FetchError({
          message: "There is already an enterprise plan for this app, create a new version instead",
          retry: false,
        })
      )
    }
  }

  const planId = newId("plan")

  const planData = await db
    .insert(schema.plans)
    .values({
      id: planId,
      slug,
      title,
      projectId,
      description: description ?? "",
      active: true,
      defaultPlan: defaultPlan ?? false,
      enterprisePlan: enterprisePlan ?? false,
    })
    .returning()
    .then((data) => data[0])

  if (!planData?.id) {
    return Err(
      new FetchError({
        message: "Error creating plan",
        retry: false,
      })
    )
  }

  return Ok(planData)
}
