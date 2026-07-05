import { TRPCError } from "@trpc/server"
import { workspaceSelectBase } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

const createWorkspaceInputSchema = z.object({
  workspaceId: z.string().min(1),
})

export const create = protectedProcedure
  .input(createWorkspaceInputSchema)
  .output(
    z.object({
      workspace: workspaceSelectBase,
    })
  )
  .mutation(async (opts) => {
    const { workspaceId } = opts.input
    const userId = opts.ctx.userId
    const userEmail = opts.ctx.session.user.email
    const { customers, projects, workspaces } = opts.ctx.services

    if (!userEmail) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "User email not found in session",
      })
    }

    const { err: countErr, val: membershipCount } = await workspaces.countMembershipsByUser({
      userId,
    })

    if (countErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: countErr.message,
      })
    }

    const isPersonal = membershipCount === 0

    const { err: projectErr, val: mainProject } = await projects.getMainProjectBySlug({
      slug: "unprice-admin",
    })

    if (projectErr || !mainProject?.id) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: projectErr?.message ?? "Main project not found",
      })
    }

    const { err: customerErr, val: customer } = await customers.getCustomerByExternalId(
      mainProject.id,
      workspaceId,
      { skipCache: true }
    )

    if (customerErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: customerErr.message,
      })
    }

    if (!customer) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Workspace signup session not found",
      })
    }

    if (customer.email.toLowerCase() !== userEmail.toLowerCase()) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Workspace signup session does not belong to the active user",
      })
    }

    const { result: subscription, error: subscriptionErr } = await unprice.subscriptions.get({
      customerId: customer.id,
    })

    if (subscriptionErr) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: subscriptionErr.message,
      })
    }

    if (!subscription) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Subscription not found",
      })
    }

    const { err, val } = await workspaces.createWorkspaceRecord({
      input: {
        id: workspaceId,
        name: customer.name,
        unPriceCustomerId: customer.id,
        isPersonal,
      },
      userId,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "user_not_found") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "User not found",
      })
    }

    if (val.state === "member_creation_failed") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error creating member",
      })
    }

    if (val.state === "workspace_claim_conflict") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Workspace signup session has already been claimed",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Workspace not created",
      })
    }

    return {
      workspace: val.workspace,
    }
  })
