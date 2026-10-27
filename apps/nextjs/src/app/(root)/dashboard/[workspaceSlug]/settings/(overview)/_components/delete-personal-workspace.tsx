"use client"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"

import { AUTH_ROUTES } from "@unprice/config"
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
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { signOutAfterAccountDeletion } from "~/actions/sign-out-after-account-deletion"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

export function DeletePersonalWorkspace({
  workspace,
}: {
  workspace: Pick<Workspace, "slug">
}) {
  const trpc = useTRPC()
  const [confirmation, setConfirmation] = useState("")

  const title = "Delete workspace"
  const description =
    "Permanently delete this personal workspace, its projects and data, and your Unprice account. Your workspace subscription is cancelled first."

  const { mutate, isPending } = useMutation(
    trpc.workspaces.deletePersonal.mutationOptions({
      onSuccess: async () => {
        toastAction("deleted")

        // the account is gone, so the session must go too; the next sign-in starts onboarding
        await signOutAfterAccountDeletion()
        window.location.href = AUTH_ROUTES.SIGNIN
      },
    })
  )

  const isConfirmed = confirmation.trim() === workspace.slug

  function handleDelete() {
    if (!isConfirmed) return

    mutate({
      workspaceSlug: workspace.slug,
      confirmation: confirmation.trim(),
    })
  }

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-destructive">Danger zone</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardFooter className="border-t px-6 py-4">
        <Dialog onOpenChange={(open) => !open && setConfirmation("")}>
          <DialogTrigger asChild>
            <Button variant="destructive">{title}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <div className="flex items-center font-bold text-destructive">
              <Warning className="mr-2 h-6 w-6" />
              <p>This action cannot be undone. You will be signed out.</p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="delete-personal-workspace-confirmation">
                Type <span className="font-mono font-semibold">{workspace.slug}</span> to confirm
              </Label>
              <Input
                id="delete-personal-workspace-confirmation"
                autoComplete="off"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={workspace.slug}
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>

              <SubmitButton
                component="spinner"
                variant="destructive"
                isDisabled={!isConfirmed || isPending}
                isSubmitting={isPending}
                label="Delete workspace and account"
                onClick={handleDelete}
              />
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardFooter>
    </Card>
  )
}
