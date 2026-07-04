import { z } from "zod"

const appRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/") && !value.startsWith("//"), {
    message: "Expected an app-relative path",
  })

export const workspaceUpgradeIntentSchema = z.object({
  source: z.enum(["billing", "feature_block", "usage_limit"]),
  workspaceSlug: z.string().min(1),
  returnTo: appRelativePathSchema,
  blockedFeatureSlug: z.string().min(1).optional(),
  targetPlanVersionId: z.string().min(1).optional(),
})

export type WorkspaceUpgradeIntent = z.infer<typeof workspaceUpgradeIntentSchema>

export function encodeWorkspaceUpgradeIntent(intent: WorkspaceUpgradeIntent): URLSearchParams {
  const parsedIntent = workspaceUpgradeIntentSchema.parse(intent)
  const params = new URLSearchParams()

  params.set("source", parsedIntent.source)
  params.set("workspaceSlug", parsedIntent.workspaceSlug)
  params.set("returnTo", parsedIntent.returnTo)

  if (parsedIntent.blockedFeatureSlug) {
    params.set("blockedFeatureSlug", parsedIntent.blockedFeatureSlug)
  }

  if (parsedIntent.targetPlanVersionId) {
    params.set("targetPlanVersionId", parsedIntent.targetPlanVersionId)
  }

  return params
}

export function parseWorkspaceUpgradeIntent(
  searchParams: URLSearchParams
): WorkspaceUpgradeIntent | null {
  const result = workspaceUpgradeIntentSchema.safeParse({
    source: searchParams.get("source"),
    workspaceSlug: searchParams.get("workspaceSlug"),
    returnTo: searchParams.get("returnTo"),
    blockedFeatureSlug: searchParams.get("blockedFeatureSlug") ?? undefined,
    targetPlanVersionId: searchParams.get("targetPlanVersionId") ?? undefined,
  })

  return result.success ? result.data : null
}
