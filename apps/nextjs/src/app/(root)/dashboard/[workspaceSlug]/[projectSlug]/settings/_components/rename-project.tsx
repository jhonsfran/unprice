"use client"

import { useRouter } from "next/navigation"
import { use } from "react"

import type { RenameProject } from "@unprice/db/validators"
import { renameProjectSchema } from "@unprice/db/validators"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { Input } from "@unprice/ui/input"
import { LoadingAnimation } from "@unprice/ui/loading-animation"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@unprice/ui/card"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

export function RenameProjectForm(props: {
  projectPromise: Promise<RouterOutputs["projects"]["getBySlug"]>
}) {
  const { project } = use(props.projectPromise)
  const router = useRouter()

  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const renameProject = useMutation(
    trpc.projects.rename.mutationOptions({
      onSettled: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.projects.listByWorkspace.queryKey({
            workspaceSlug: project.workspace.slug,
          }),
        })
        await queryClient.invalidateQueries({
          queryKey: trpc.projects.getBySlug.queryKey({ slug: project.slug }),
        })
        router.refresh()
      },
      onSuccess: () => {
        toastAction("success")
      },
    })
  )

  const form = useZodForm({
    schema: renameProjectSchema,
    defaultValues: {
      slug: project.slug,
      name: project.name,
    },
  })

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(async (data: RenameProject) => {
          await renameProject.mutateAsync(data)
        })}
      >
        <Card>
          <CardHeader>
            <CardTitle>Project name</CardTitle>
            <CardDescription>
              Change the display name shown in dashboard navigation and project-level evidence.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="my-project" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>

          <CardFooter className="flex justify-between gap-2 border-t px-6 py-4">
            <Button type="submit">
              Save project name
              {form.formState.isSubmitting && <LoadingAnimation className="ml-2" />}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </Form>
  )
}
