import {
  deletePersonalWorkspaceInputSchema,
  deletePersonalWorkspaceOutputSchema,
} from "@unprice/services/use-cases"
import { protectedWorkspaceProcedure } from "#trpc"
import { deletePersonalMutation } from "./deletePersonal.impl"

export const deletePersonal = protectedWorkspaceProcedure
  .input(deletePersonalWorkspaceInputSchema)
  .output(deletePersonalWorkspaceOutputSchema)
  .mutation(deletePersonalMutation)
