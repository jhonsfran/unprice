import { TRPCError } from "@trpc/server"
import { workspaceInsertBase, workspaceSelectBase } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

export const create = protectedProcedure
  .input(
    workspaceInsertBase.required({
      name: true,
      unPriceCustomerId: true,
    })
  )
  .output(
    z.object({
      workspace: workspaceSelectBase,
    })
  )
  .mutation(async (opts) => {
    const userId = opts.ctx.userId
    const { workspaces } = opts.ctx.services

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

    const { result: subscription, error: subscriptionErr } =
      await unprice.customers.getSubscription({
        customerId: opts.input.unPriceCustomerId,
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
        ...opts.input,
        isPersonal,
      },
      userId,
      plan: subscription.planSlug,
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
