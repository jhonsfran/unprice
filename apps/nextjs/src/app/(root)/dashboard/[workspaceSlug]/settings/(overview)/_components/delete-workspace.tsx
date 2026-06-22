"use client"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { startTransition } from "react"

import type { Workspace } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"
import { Warning } from "@unprice/ui/icons"
import { updateSession } from "~/actions/update-session"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

export function DeleteWorkspace({ workspace }: { workspace: Workspace }) {
  const isPersonal = workspace.isPersonal
  const isMain = workspace.isMain

  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const title = "Delete"
  const description = "This will delete the workspace and all of its data."

  const deleteWorkspace = useMutation(
    trpc.workspaces.delete.mutationOptions({
      onSuccess: async () => {
        toastAction("deleted")

        // invalidate the workspaces list to refresh the workspaces
        await queryClient.invalidateQueries({
          queryKey: trpc.workspaces.listWorkspacesByActiveUser.queryKey(),
        })

        // trigger the session update
        await updateSession()

        // redirect url
        window.location.href = "/"
      },
    })
  )

  function handleDelete() {
    startTransition(() => {
      deleteWorkspace.mutate({
        id: workspace.id,
      })
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardFooter className="border-t px-6 py-4">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive" disabled={!!isPersonal || !!isMain}>
              {title}
            </Button>
          </DialogTrigger>
          {!!isPersonal && (
            <span className="mr-auto px-2 text-muted-foreground text-xs">
              You cannot delete your personal workspace. Contact support if you want to delete your
              account.
            </span>
          )}
          {isMain && (
            <span className="mr-auto px-2 text-muted-foreground text-xs">
              You cannot delete your main workspace.
            </span>
          )}
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <div className="flex items-center font-bold text-destructive">
              <Warning className="mr-2 h-6 w-6" />
              <p>This action cannot be undone.</p>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>

              <SubmitButton
                component="spinner"
                variant="destructive"
                isDisabled={deleteWorkspace.isPending}
                isSubmitting={deleteWorkspace.isPending}
                label="I'm sure. Delete this workspace"
                onClick={handleDelete}
              />
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardFooter>
    </Card>
  )
}
