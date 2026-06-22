"use client"

import { useRouter } from "next/navigation"
import { use } from "react"

import type { ProjectTransferToWorkspace } from "@unprice/db/validators"
import { transferToWorkspaceSchema } from "@unprice/db/validators"
import type { RouterOutputs } from "@unprice/trpc/routes"
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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

export function TransferProjectToTeam({
  workspacesPromise,
  projectSlug,
  workspaceSlug,
  isMain,
}: {
  projectSlug: string
  workspaceSlug: string
  workspacesPromise: Promise<RouterOutputs["workspaces"]["listWorkspacesByActiveUser"]>
  isMain: boolean
}) {
  const { workspaces } = use(workspacesPromise)
  const router = useRouter()
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const form = useZodForm({
    schema: transferToWorkspaceSchema,
    defaultValues: {
      projectSlug,
    },
  })

  const transferToWorkspace = useMutation(
    trpc.projects.transferToWorkspace.mutationOptions({
      onSuccess: async (data) => {
        toastAction("success")
        await queryClient.invalidateQueries({
          queryKey: trpc.projects.listByActiveWorkspace.queryKey(),
        })
        // redirect to the new workspace
        router.push(`/${data?.workspaceSlug}`)
      },
    })
  )

  async function onSubmit(data: ProjectTransferToWorkspace) {
    await transferToWorkspace.mutateAsync(data)
  }

  const title = "Transfer to Team"
  const description = "Transfer this project to a team workspace"

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
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <DialogHeader>
                  <DialogTitle>{title}</DialogTitle>
                  <DialogDescription>{description}</DialogDescription>
                </DialogHeader>

                <FormField
                  control={form.control}
                  name="targetWorkspaceId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Organization</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a plan" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {workspaces
                            .filter((wk) => wk.slug !== workspaceSlug)
                            .map((wk) => (
                              <SelectItem key={wk.id} value={wk.id}>
                                {wk.name ?? wk.slug}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline">Cancel</Button>
                  </DialogClose>
                  <Button
                    variant="destructive"
                    type="submit"
                    disabled={form.formState.isSubmitting}
                  >
                    {`I'm sure. Transfer this project`}
                    {form.formState.isSubmitting && <LoadingAnimation />}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </CardFooter>
    </Card>
  )
}
