"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { Workspace } from "@unprice/db/validators"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@unprice/ui/card"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { Input } from "@unprice/ui/input"
import { useRouter } from "next/navigation"
import { z } from "zod"

import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

export function WorkspaceName(props: {
  workspace: Workspace
}) {
  const router = useRouter()

  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const form = useZodForm({
    schema: z.object({
      name: z.string().min(3, "Name must be at least 3 characters"),
    }),
    defaultValues: {
      name: props.workspace.name,
    },
  })

  const renamedWorkspace = useMutation(
    trpc.workspaces.rename.mutationOptions({
      onSettled: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.workspaces.listWorkspacesByActiveUser.queryKey(),
        })
        router.refresh()
      },
      onSuccess: () => {
        toastAction("success")
      },
    })
  )

  async function onSubmit(data: { name: string }) {
    await renamedWorkspace.mutateAsync(data)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace Name</CardTitle>
        <CardDescription>Change the name of your workspace</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            id="workspace-name"
            className="flex flex-col space-y-2"
            onSubmit={form.handleSubmit(onSubmit)}
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="unprice" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
      </CardContent>
      <CardFooter className="border-t px-6 py-4">
        <SubmitButton
          form="workspace-name"
          type="submit"
          isDisabled={form.formState.isSubmitting}
          isSubmitting={form.formState.isSubmitting}
          label="Save Workspace"
        />
      </CardFooter>
    </Card>
  )
}
