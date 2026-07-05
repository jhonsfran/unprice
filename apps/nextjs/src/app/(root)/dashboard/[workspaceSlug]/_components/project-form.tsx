"use client"

import { useParams, useRouter } from "next/navigation"

import {
  type Project,
  type ProjectInsert,
  projectInsertBaseSchema,
  projectSelectBaseSchema,
} from "@unprice/db/validators"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@unprice/ui/form"
import { Input } from "@unprice/ui/input"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CURRENCIES } from "@unprice/db/utils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { CopyButton } from "~/components/copy-button"
import TimeZoneFormField from "~/components/forms/timezone-field"
import { SubmitButton } from "~/components/submit-button"
import { useIsOnboarding } from "~/hooks/use-features"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

export function ProjectForm(props: {
  onSuccess?: (project: Project) => void
  defaultValues: ProjectInsert | Project
}) {
  const router = useRouter()
  const workspaceSlug = useParams().workspaceSlug as string
  const trpc = useTRPC()
  const [isOnboarding] = useIsOnboarding()
  const queryClient = useQueryClient()

  const editMode = !!props.defaultValues.id
  const formSchema = editMode ? projectSelectBaseSchema : projectInsertBaseSchema

  const form = useZodForm({
    schema: formSchema,
    defaultValues: props.defaultValues,
  })

  const updateProject = useMutation(
    trpc.projects.update.mutationOptions({
      onSuccess: async (data) => {
        const { project: newProject } = data

        toastAction("updated", "Project saved")

        // invalidate the projects query
        await queryClient.invalidateQueries({
          queryKey: trpc.projects.listByActiveWorkspace.queryKey(),
        })

        // router refresh
        router.refresh()

        if (props.onSuccess) {
          props.onSuccess(newProject)
        }
      },
    })
  )

  const createProject = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: async (data) => {
        const { project: newProject } = data

        toastAction("saved", "Project created")

        // invalidate the projects query
        await queryClient.invalidateQueries({
          queryKey: trpc.projects.listByActiveWorkspace.queryKey(),
        })

        // router refresh
        router.refresh()

        props.onSuccess?.(newProject)

        if (!isOnboarding) {
          router.push(`/${workspaceSlug}/${newProject?.slug}`)
        }
      },
    })
  )

  const onSubmit = async (data: ProjectInsert | Project) => {
    if (editMode) {
      await updateProject.mutateAsync(data as Project)
    } else {
      await createProject.mutateAsync(data as ProjectInsert)
    }
  }

  return (
    <Form {...form}>
      <form className="space-y-6">
        {editMode && (
          <div className="flex items-center justify-between">
            <div>
              <FormLabel>Project ID</FormLabel>
              <FormDescription>{props.defaultValues.id}</FormDescription>
            </div>
            <CopyButton value={props.defaultValues.id ?? ""} className="size-4" />
          </div>
        )}
        <div className="space-y-8">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name *</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="unprice" />
                </FormControl>
                <FormDescription>A name to identify your project in the dashboard.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* <FormField
            control={form.control}
            name="url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>URL</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="https://unprice.dev" />
                </FormControl>
                <FormDescription>The URL of your project</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          /> */}

          {/* <FormField
            control={form.control}
            name="contactEmail"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Contact Email</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="contact@unprice.dev" />
                </FormControl>
                <FormDescription>The email to contact for enterprise plans</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          /> */}

          <FormField
            control={form.control}
            name="defaultCurrency"
            render={({ field }) => (
              <FormItem className="flex flex-col justify-end">
                <FormLabel>Currency</FormLabel>

                <FormDescription>
                  Default currency for all plans and features. You can override this for each plan
                  and feature.
                </FormDescription>
                <Select onValueChange={field.onChange} value={field.value ?? ""}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a currency" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {CURRENCIES.map((currency) => (
                      <SelectItem key={currency} value={currency}>
                        {currency}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <TimeZoneFormField form={form} />
        </div>

        <div className="flex justify-end space-x-4 pt-8">
          <SubmitButton
            onClick={() => form.handleSubmit(onSubmit)()}
            isDisabled={form.formState.isSubmitting}
            isSubmitting={form.formState.isSubmitting}
            label={editMode ? "Save project" : "Create project"}
          />
        </div>
      </form>
    </Form>
  )
}
