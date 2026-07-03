import type { Member } from "@unprice/db/validators"

export function canAssignWorkspaceRole({
  actorRole,
  targetRole,
}: {
  actorRole: Member["role"]
  targetRole: Member["role"]
}): boolean {
  return targetRole !== "OWNER" || actorRole === "OWNER"
}
