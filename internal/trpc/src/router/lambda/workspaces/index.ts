import { createTRPCRouter } from "#trpc"
import { changePlan } from "./changePlan"
import { changeRoleInvite } from "./changeRoleInvite"
import { changeRoleMember } from "./changeRoleMember"
import { create } from "./create"
import { deleteWorkspace } from "./delete"
import { deleteInvite } from "./deleteInvite"
import { deleteMember } from "./deleteMember"
import { getBillingOverview } from "./getBillingOverview"
import { getBySlug } from "./getBySlug"
import { getUpgradeOptions } from "./getUpgradeOptions"
import { inviteMember } from "./inviteMember"
import { listInvitesByActiveWorkspace } from "./listInvitesByActiveWorkspace"
import { listMembersByActiveWorkspace } from "./listMembersByActiveWorkspace"
import { listWorkspacesByActiveUser } from "./listWorkspacesByActiveUser"
import { rename } from "./rename"
import { resendInvite } from "./resendInvite"
import { signUp } from "./signUp"

export const workspaceRouter = createTRPCRouter({
  create: create,
  changePlan: changePlan,
  signUp: signUp,
  deleteMember: deleteMember,
  getBillingOverview: getBillingOverview,
  getUpgradeOptions: getUpgradeOptions,
  listMembersByActiveWorkspace: listMembersByActiveWorkspace,
  getBySlug: getBySlug,
  delete: deleteWorkspace,
  listWorkspacesByActiveUser: listWorkspacesByActiveUser,
  rename: rename,
  changeRoleMember: changeRoleMember,
  listInvitesByActiveWorkspace: listInvitesByActiveWorkspace,
  deleteInvite: deleteInvite,
  inviteMember: inviteMember,
  resendInvite: resendInvite,
  changeRoleInvite: changeRoleInvite,
})
