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
import { LoadingAnimation } from "@unprice/ui/loading-animation"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

// TODO: could use server actions
export function TransferProjectToPersonal({
  projectSlug,
  isMain,
}: {
  projectSlug: string
  isMain: boolean
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const transferProjectToPersonal = useMutation(
    trpc.projects.transferToPersonal.mutationOptions({
      onSuccess: async (data) => {
        toastAction("success")
        await queryClient.invalidateQueries({
          queryKey: trpc.projects.listByActiveWorkspace.queryKey(),
        })
        router.push(`/${data?.workspaceSlug}`)
      },
    })
  )

  const title = "Transfer to Personal"
  const description = "Transfer this project to your personal workspace"

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
              You cannot transfer the main project.
            </span>
          )}
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button
                variant="destructive"
                disabled={transferProjectToPersonal.isPending}
                onClick={() => {
                  transferProjectToPersonal.mutate({
                    slug: projectSlug,
                  })
                }}
              >
                {`I'm sure. Transfer this project`}
                {transferProjectToPersonal.isPending && <LoadingAnimation className="ml-2" />}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardFooter>
    </Card>
  )
}
