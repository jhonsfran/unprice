"use client"

import { useMutation } from "@tanstack/react-query"
import { APP_DOMAIN } from "@unprice/config"
import { type WorkspaceSignup, workspaceSignupSchema } from "@unprice/db/validators"
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
import { SubmitButton } from "~/components/submit-button"
import { toBrowserAbsoluteUrl } from "~/lib/browser-url"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

export default function NewWorkspaceForm({
  setDialogOpen,
  defaultValues,
}: {
  defaultValues: WorkspaceSignup
  setDialogOpen?: (open: boolean) => void
}) {
  const trpc = useTRPC()
  const form = useZodForm({
    schema: workspaceSignupSchema,
    defaultValues: {
      ...defaultValues,
      successUrl: `${APP_DOMAIN}new`,
      cancelUrl: `${APP_DOMAIN}`,
    },
  })

  const signUpWorkspace = useMutation(
    trpc.workspaces.signUp.mutationOptions({
      onSuccess: async ({ url }) => {
        setDialogOpen?.(false)

        // redirect url
        window.location.href = url
      },
    })
  )

  const onSubmitForm = async (data: WorkspaceSignup) => {
    await signUpWorkspace.mutateAsync({
      ...data,
      successUrl: toBrowserAbsoluteUrl("/new"),
      cancelUrl: toBrowserAbsoluteUrl("/"),
    })
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmitForm)} className="flex w-full flex-col gap-6">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Workspace name</FormLabel>
              <FormDescription>
                This is the name of the workspace that will be displayed in the UI.
              </FormDescription>
              <FormControl>
                <Input {...field} placeholder="Acme Inc." value={field.value ?? ""} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-4 pt-2">
          <SubmitButton
            onClick={() => form.handleSubmit(onSubmitForm)()}
            isSubmitting={form.formState.isSubmitting}
            isDisabled={form.formState.isSubmitting}
            label="Create"
          />
        </div>
      </form>
    </Form>
  )
}
