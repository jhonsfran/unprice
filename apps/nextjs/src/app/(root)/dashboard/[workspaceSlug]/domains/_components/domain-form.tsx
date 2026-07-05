"use client"

import { useRouter } from "next/navigation"
import { useEffect, useTransition } from "react"

import { useMutation } from "@tanstack/react-query"
import type { CreateDomain, Domain } from "@unprice/db/validators"
import { domainCreateBaseSchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"

import { ConfirmAction } from "~/components/confirm-action"
import { InputWithAddons } from "~/components/input-addons"
import { SubmitButton } from "~/components/submit-button"
import { useDebounce } from "~/hooks/use-debounce"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

export function DomainForm({
  onSubmit,
  defaultValues,
}: {
  onSubmit?: (data?: Domain) => void
  defaultValues: CreateDomain
}) {
  const router = useRouter()
  const trpc = useTRPC()

  const form = useZodForm({
    schema: domainCreateBaseSchema,
    mode: "onChange",
    defaultValues: defaultValues,
  })

  const [_isPending, startTransition] = useTransition()

  const editMode = !!defaultValues.id
  const watchDomain = form.watch("name")
  const debouncedDomain = useDebounce(watchDomain, 1000)
  const domainExist = useMutation(trpc.domains.exists.mutationOptions())

  // TODO: compare with the validation on feature-form.tsx
  useEffect(() => {
    if (debouncedDomain) {
      void domainExist
        .mutateAsync({
          domain: debouncedDomain,
        })
        .then((res) => {
          if (res.exist) {
            if (form.getValues("name") === defaultValues.name) {
              return
            }

            form.setError("name", {
              type: "custom",
              message: "Domain already exists",
            })
          } else {
            const error = form.formState.errors.name

            if (error?.type === "custom") {
              form.clearErrors("name")
            }
          }
        })
    }
  }, [debouncedDomain])

  const createDomain = useMutation(
    trpc.domains.create.mutationOptions({
      onSuccess: ({ domain }) => {
        form.reset(defaultValues)
        toastAction("saved", "Domain added")
        router.refresh()
        onSubmit?.(domain)
      },
    })
  )

  const updateDomain = useMutation(
    trpc.domains.update.mutationOptions({
      onSuccess: ({ domain }) => {
        form.reset()
        toastAction("updated", "Domain saved")
        router.refresh()
        onSubmit?.(domain)
      },
    })
  )

  const deleteDomain = useMutation(trpc.domains.remove.mutationOptions())

  function onDelete() {
    startTransition(async () => {
      if (!defaultValues.id) return
      await deleteDomain.mutateAsync({ id: defaultValues.id })
      form.reset()
      toastAction("deleted", "Domain deleted")
      router.refresh()
    })
  }

  const onSubmitForm = async (values: CreateDomain) => {
    if (!defaultValues.id) {
      await createDomain.mutateAsync(values)
    }

    if (defaultValues.id) {
      await updateDomain.mutateAsync({ ...values, id: defaultValues.id })
    }
  }

  const submitDisabled =
    form.formState.isSubmitting || domainExist.isPending || !form.formState.isValid

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmitForm)}>
        <div className="space-y-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Domain</FormLabel>
                <FormControl>
                  <InputWithAddons {...field} placeholder="status.unprice.dev" leading="https://" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="mt-8 flex justify-end space-x-2">
          {editMode && (
            <ConfirmAction
              confirmAction={() => {
                onSubmit?.() // close the dialog
                onDelete()
              }}
            >
              <Button variant={"ghost"}>Delete</Button>
            </ConfirmAction>
          )}
          <SubmitButton
            isSubmitting={form.formState.isSubmitting}
            isDisabled={submitDisabled}
            label={editMode ? "Save domain" : "Add domain"}
          />
        </div>
      </form>
    </Form>
  )
}
