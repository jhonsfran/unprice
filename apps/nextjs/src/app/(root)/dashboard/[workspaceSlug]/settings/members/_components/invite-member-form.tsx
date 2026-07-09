"use client"

import { useRouter } from "next/navigation"

import * as utils from "@unprice/db/utils"
import type { InviteMember } from "@unprice/db/validators"
import { inviteMembersSchema } from "@unprice/db/validators"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"

import { useMutation } from "@tanstack/react-query"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

export const InviteMemberForm = ({
  onSuccess,
}: {
  onSuccess: () => void
}) => {
  const router = useRouter()
  const trpc = useTRPC()
  const form = useZodForm({
    schema: inviteMembersSchema,
    defaultValues: {
      email: "",
      role: utils.ROLES_APP[0],
      name: "",
    },
  })

  const inviteMember = useMutation(
    trpc.workspaces.inviteMember.mutationOptions({
      onSettled: () => {
        router.refresh()
      },
      onSuccess: () => {
        toastAction("success")
        form.reset()
        onSuccess()
      },
    })
  )

  async function onSubmit(data: InviteMember) {
    await inviteMember.mutateAsync(data)
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <div className="space-y-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormDescription>The name of the person you want to invite.</FormDescription>
                <FormControl>
                  <Input {...field} placeholder="John Doe" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormDescription>
                  The email address of the person you want to invite.
                </FormDescription>
                <FormControl>
                  <Input {...field} placeholder="john@doe.com" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="role"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Role</FormLabel>
                <FormDescription>The role of the person you want to invite.</FormDescription>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a plan" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {utils.ROLES_APP.map((role) => (
                      <SelectItem key={role} value={role}>
                        {role}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex justify-end space-x-4 pt-8">
          <SubmitButton
            isDisabled={form.formState.isSubmitting}
            isSubmitting={form.formState.isSubmitting}
            label="Invite Member"
          />
        </div>
      </form>
    </Form>
  )
}
