import {
  workspaceChangePlanInputSchema,
  workspaceChangePlanOutputSchema,
} from "@unprice/services/use-cases"
import { protectedWorkspaceProcedure } from "#trpc"
import { changePlanMutation } from "./changePlan.impl"

export const changePlan = protectedWorkspaceProcedure
  .input(workspaceChangePlanInputSchema)
  .output(workspaceChangePlanOutputSchema)
  .mutation(changePlanMutation)
