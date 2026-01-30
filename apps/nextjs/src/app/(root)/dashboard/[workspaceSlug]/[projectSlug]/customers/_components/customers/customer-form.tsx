"use client"

import { useRouter } from "next/navigation"
import { startTransition } from "react"

import type { InsertCustomer } from "@unprice/db/validators"
import { customerInsertBaseSchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
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
import { Textarea } from "@unprice/ui/text-area"

import { useMutation } from "@tanstack/react-query"
import { CURRENCIES } from "@unprice/db/utils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Switch } from "@unprice/ui/switch"
import { ConfirmAction } from "~/components/confirm-action"
import { CopyButton } from "~/components/copy-button"
import TimeZoneFormField from "~/components/forms/timezone-field"
import { SubmitButton } from "~/components/submit-button"
import { toast, toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

export function CustomerForm({
  setDialogOpen,
  defaultValues,
}: {
  setDialogOpen?: (open: boolean) => void
  defaultValues: InsertCustomer
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const editMode = !!defaultValues.id

  // async validation only when creating a new customer
  const formSchema = customerInsertBaseSchema

  const form = useZodForm({
    schema: formSchema,
    defaultValues: {
      ...defaultValues,
      active: defaultValues.active ?? false,
      timezone: defaultValues.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  })

  const createCustomer = useMutation(
    trpc.customers.create.mutationOptions({
      onSuccess: ({ customer }) => {
        form.reset(customer)
        toastAction("saved")
        setDialogOpen?.(false)
        router.refresh()
      },
    })
  )

  const updateCustomer = useMutation(
    trpc.customers.update.mutationOptions({
      onSuccess: ({ customer }) => {
        form.reset(customer)
        toastAction("updated")
        setDialogOpen?.(false)

        // Only needed when the form is inside a uncontrolled dialog - normally updates
        // FIXME: hack to close the dialog when the form is inside a uncontrolled dialog
        if (!setDialogOpen) {
          const escKeyEvent = new KeyboardEvent("keydown", {
            key: "Escape",
          })
          document.dispatchEvent(escKeyEvent)
        }

        router.refresh()
      },
      onError: (_error) => {},
    })
  )

  const deleteCustomer = useMutation(
    trpc.customers.remove.mutationOptions({
      onSuccess: () => {
        // TODO: if the form is inside a page, we need to refresh and go back to the previous page
        form.reset()
        router.refresh()
      },
    })
  )

  const onSubmitForm = async (data: InsertCustomer) => {
    try {
      if (!defaultValues.id) {
        await createCustomer.mutateAsync(data)
      }

      if (defaultValues.id && defaultValues.projectId) {
        await updateCustomer.mutateAsync({
          ...data,
          id: defaultValues.id,
          active: data.active ?? false,
        })
      }
    } catch {
      // Error is already handled by the global mutationCache.onError handler
      // We just need to catch it here to prevent unhandled promise rejection
      // The toast with error details (including request ID) is already shown
    }
  }

  function onDelete() {
    startTransition(() => {
      if (!defaultValues.id) {
        toastAction("error", "no data defined")
        return
      }

      toast.promise(deleteCustomer.mutateAsync({ id: defaultValues.id }), {
        loading: "Removing...",
        success: "Customer removed",
      })

      setDialogOpen?.(false)
    })
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmitForm)} className="space-y-6">
        <div className="space-y-8">
          {editMode && (
            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Active</FormLabel>
                    <FormDescription>Is this customer active?</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {editMode && (
            <div className="flex items-center justify-between">
              <div>
                <FormLabel>Customer ID</FormLabel>
                <FormDescription>{defaultValues.id}</FormDescription>
              </div>
              <CopyButton value={defaultValues.id ?? ""} className="size-4" />
            </div>
          )}

          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>name</FormLabel>
                <FormDescription>Name of the customer.</FormDescription>
                <FormControl>
                  <Input {...field} />
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
                <FormLabel>email</FormLabel>
                <FormDescription>Main email address of the customer.</FormDescription>
                <FormControl>
                  <Input {...field} placeholder="email" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="defaultCurrency"
            render={({ field }) => (
              <FormItem className="flex flex-col justify-end">
                <FormLabel>Currency</FormLabel>

                <FormDescription>
                  This customer will use this currency for all its invoices.
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

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormDescription>Description of the customer.</FormDescription>
                <FormControl>
                  <Textarea {...field} value={field.value ?? ""} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="mt-8 flex justify-end space-x-4">
          {editMode && (
            <ConfirmAction
              confirmAction={() => {
                setDialogOpen?.(false)
                onDelete()
              }}
            >
              <Button variant={"link"} disabled={deleteCustomer.isPending}>
                Delete
              </Button>
            </ConfirmAction>
          )}
          <SubmitButton
            onClick={() => form.handleSubmit(onSubmitForm)()}
            isSubmitting={form.formState.isSubmitting}
            isDisabled={form.formState.isSubmitting}
            label={editMode ? "Update" : "Create"}
          />
        </div>
      </form>
    </Form>
  )
}
