"use client"

import { useRouter } from "next/navigation"

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
import { LoadingAnimation } from "@unprice/ui/loading-animation"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { revalidateAppPath } from "~/actions/revalidate"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

export function DeleteProject({
  workspaceSlug,
  projectSlug,
  isMain,
}: {
  workspaceSlug: string
  projectSlug: string
  isMain: boolean
}) {
  const router = useRouter()

  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const deleteProject = useMutation(
    trpc.projects.delete.mutationOptions({
      onSuccess: async () => {
        toastAction("success")
        await queryClient.invalidateQueries({
          queryKey: trpc.projects.listByActiveWorkspace.queryKey(),
        })
        await revalidateAppPath(`/${workspaceSlug}`, "page")
        router.push(`/${workspaceSlug}`)
      },
    })
  )

  const title = "Delete project"
  const description = "This will delete the project and all of its data."

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="flex items-center">{description}</CardDescription>
      </CardHeader>
      <CardFooter className="border-t px-6 py-4">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive" disabled={isMain}>
              {title}
            </Button>
          </DialogTrigger>
          {!!isMain && (
            <span className="mr-auto px-2 text-muted-foreground text-xs">
              You cannot delete the main project.
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
              <Button
                className="button-danger"
                variant="destructive"
                onClick={() => {
                  deleteProject.mutate({
                    projectSlug: projectSlug,
                  })
                }}
              >
                {`I'm sure. Delete this project`}

                {deleteProject.isPending && <LoadingAnimation className="ml-2" />}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardFooter>
    </Card>
  )
}
