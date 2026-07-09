"use client"

import { useRouter } from "next/navigation"
import { startTransition } from "react"

import type { InsertCustomer } from "@unprice/db/validators"
import { customerInsertBaseSchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { HelpCircle } from "@unprice/ui/icons"
import { Input } from "@unprice/ui/input"
import { Textarea } from "@unprice/ui/text-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"

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
        toastAction("saved", "Customer created")
        setDialogOpen?.(false)
        router.refresh()
      },
    })
  )

  const updateCustomer = useMutation(
    trpc.customers.update.mutationOptions({
      onSuccess: ({ customer }) => {
        form.reset(customer)
        toastAction("updated", "Customer saved")
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
        <div className="space-y-5">
          {editMode && (
            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="flex items-center gap-2">
                    <FormLabel className="font-semibold text-sm">Active</FormLabel>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="size-3.5 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-[250px]">
                        Toggle to activate or deactivate this customer. Inactive customers cannot
                        create new subscriptions or report usage.
                      </TooltipContent>
                    </Tooltip>
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
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">Customer ID</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[250px]">
                      Unique identifier for this customer. Use this ID when integrating with the
                      API.
                    </TooltipContent>
                  </Tooltip>
                </div>
                <span className="text-muted-foreground text-sm">{defaultValues.id}</span>
              </div>
              <CopyButton value={defaultValues.id ?? ""} className="size-4" />
            </div>
          )}

          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center gap-2">
                  <FormLabel className="font-semibold text-sm">Name</FormLabel>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[250px]">
                      Display name for this customer. Used in dashboards, invoices, and
                      communications.
                    </TooltipContent>
                  </Tooltip>
                </div>
                <FormControl>
                  <Input {...field} placeholder="Acme Inc." />
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
                <div className="flex items-center gap-2">
                  <FormLabel className="font-semibold text-sm">Email</FormLabel>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[250px]">
                      Primary contact email for this customer. Used for invoices, notifications, and
                      account communications.
                    </TooltipContent>
                  </Tooltip>
                </div>
                <FormControl>
                  <Input {...field} placeholder="customer@example.com" />
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
                <div className="flex items-center gap-2">
                  <FormLabel className="font-semibold text-sm">Currency</FormLabel>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[250px]">
                      Default currency for this customer's invoices and billing. All prices and
                      charges will be displayed in this currency.
                    </TooltipContent>
                  </Tooltip>
                </div>
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
                <div className="flex items-center gap-2">
                  <FormLabel className="font-semibold text-sm">Description</FormLabel>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[250px]">
                      Optional notes about this customer. Useful for internal reference, special
                      requirements, or account details.
                    </TooltipContent>
                  </Tooltip>
                </div>
                <FormControl>
                  <Textarea
                    {...field}
                    value={field.value ?? ""}
                    placeholder="Add notes about this customer..."
                  />
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
            label={editMode ? "Save customer" : "Create customer"}
          />
        </div>
      </form>
    </Form>
  )
}
