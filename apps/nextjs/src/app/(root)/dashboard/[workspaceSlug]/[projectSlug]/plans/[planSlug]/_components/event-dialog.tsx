"use client"

import { type FormEvent, useEffect } from "react"
import { useFieldArray } from "react-hook-form"
import { z } from "zod"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { slugify } from "@unprice/db/utils"
import type { Event } from "@unprice/db/validators"
import { eventInsertBaseSchema } from "@unprice/db/validators"
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
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@unprice/ui/responsive-dialog"
import { Plus, XCircle } from "lucide-react"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

const eventFormSchema = z.object({
  name: eventInsertBaseSchema.shape.name,
  slug: eventInsertBaseSchema.shape.slug,
  availableProperties: z.array(
    z.object({
      value: z
        .string()
        .min(1, "Property name is required")
        .regex(/^[a-z0-9._-]+$/, {
          message:
            "Property names must contain only lowercase letters, numbers, dots, dashes, and underscores",
        }),
    })
  ),
})

export type EventFormValues = z.infer<typeof eventFormSchema>

/** A new event starts with no property: most events are counted, and a property is added when the event carries a number. */
export function toEventFormValues(
  event?: Pick<Event, "name" | "slug" | "availableProperties">
): EventFormValues {
  return {
    name: event?.name ?? "",
    slug: event?.slug ?? "",
    availableProperties: event?.availableProperties?.map((value) => ({ value })) ?? [],
  }
}

function toAvailableProperties(values: EventFormValues["availableProperties"]) {
  return Array.from(new Set(values.map((property) => property.value.trim()).filter(Boolean)))
}

export function EventFormDialog({
  open,
  onOpenChange,
  mode,
  event,
  onSaved,
  isDisabled,
  isPlanVersionLocked,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "create" | "edit"
  event?: Event
  onSaved: (event: Event) => Promise<void> | void
  isDisabled?: boolean
  isPlanVersionLocked?: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const createEvent = useMutation(trpc.events.create.mutationOptions())
  const updateEvent = useMutation(trpc.events.update.mutationOptions())
  const form = useZodForm({
    schema: eventFormSchema,
    defaultValues: toEventFormValues(event),
  })
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "availableProperties",
  })
  const immutablePropertyCount = mode === "edit" ? (event?.availableProperties?.length ?? 0) : 0

  useEffect(() => {
    if (!open) {
      return
    }

    form.reset(toEventFormValues(event))
  }, [event?.id, form, open])

  const isPending = createEvent.isPending || updateEvent.isPending
  const isCreateDisabled = Boolean(isDisabled && mode === "create")
  const isExistingEventMetadataLocked = Boolean(isPlanVersionLocked && mode === "edit")

  const onSubmit = async (data: EventFormValues) => {
    const availableProperties = toAvailableProperties(data.availableProperties)

    const result =
      mode === "create"
        ? await createEvent.mutateAsync({
            name: data.name,
            slug: data.slug,
            availableProperties,
          })
        : await updateEvent.mutateAsync({
            id: event!.id,
            name: data.name,
            availableProperties,
          })

    await queryClient.invalidateQueries({
      queryKey: trpc.events.listByActiveProject.queryKey(),
    })

    toastAction(mode === "create" ? "saved" : "updated")
    await onSaved(result.event)
    onOpenChange(false)
  }

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.stopPropagation()
    void form.handleSubmit(onSubmit)(event)
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="md:max-w-[620px]">
        <ResponsiveDialogHeader className="space-y-2">
          <ResponsiveDialogTitle>
            {mode === "create" ? "Create event" : isPlanVersionLocked ? "View event" : "Edit event"}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Events are reusable across features. Add the SDK slug once. An event is counted unless
            it carries a number to sum, such as tokens.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <Form {...form}>
          <form onSubmit={handleFormSubmit} className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="space-y-2">
                    <FormLabel>Name</FormLabel>
                    <FormDescription>Internal label shown in the dashboard.</FormDescription>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="AI completion"
                        disabled={isCreateDisabled || isExistingEventMetadataLocked || isPending}
                        onChange={(e) => {
                          field.onChange(e)

                          if (mode === "create") {
                            form.setValue("slug", slugify(e.target.value))
                          }
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem className="space-y-2">
                    <FormLabel>SDK Slug</FormLabel>
                    <FormDescription>Slugs are immutable after creation.</FormDescription>
                    <FormControl>
                      <Input
                        {...field}
                        className="font-mono"
                        placeholder="ai_completion"
                        disabled={isCreateDisabled || isPending || mode === "edit"}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="space-y-3 rounded-lg bg-background-bgSubtle/30 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-medium text-sm">Numeric properties</p>
                  <p className="text-muted-foreground text-xs">
                    Payload fields the event carries a number in, like `input_tokens` or
                    `active_seats`. Leave empty for an event that is counted.
                    {mode === "edit" ? " Existing properties cannot be removed." : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={isCreateDisabled || isPending}
                  onClick={() => append({ value: "" })}
                >
                  <Plus className="mr-2 size-3.5" />
                  Add property
                </Button>
              </div>

              {fields.length ? (
                <div className="space-y-2">
                  {fields.map((field, index) => {
                    const isImmutableProperty = mode === "edit" && index < immutablePropertyCount

                    return (
                      <div key={field.id} className="flex items-start gap-2">
                        <FormField
                          control={form.control}
                          name={`availableProperties.${index}.value`}
                          render={({ field }) => (
                            <FormItem className="flex-1 space-y-1">
                              <FormControl>
                                <Input
                                  {...field}
                                  className="font-mono"
                                  placeholder="input_tokens"
                                  disabled={isCreateDisabled || isPending || isImmutableProperty}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="mt-0.5 shrink-0"
                          disabled={isCreateDisabled || isPending || isImmutableProperty}
                          onClick={() => remove(index)}
                        >
                          <XCircle className="size-4" />
                          <span className="sr-only">
                            {isImmutableProperty
                              ? "Existing properties cannot be removed"
                              : "Remove property"}
                          </span>
                        </Button>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-dashed px-3 py-4 text-center text-muted-foreground text-xs">
                  No numeric properties: each event counts as one. Add a property to sum, max, or
                  take the latest value instead.
                </div>
              )}
            </div>

            <ResponsiveDialogFooter className="pt-2">
              <SubmitButton
                isSubmitting={form.formState.isSubmitting}
                isDisabled={isCreateDisabled || isPending}
                label={mode === "create" ? "Create event" : "Save event"}
              />
            </ResponsiveDialogFooter>
          </form>
        </Form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
