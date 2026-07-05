"use client"

import { useRouter } from "next/navigation"
import { startTransition } from "react"
import { z } from "zod"

import { slugify } from "@unprice/db/utils"
import type { InsertFeature } from "@unprice/db/validators"
import { featureInsertBaseSchema } from "@unprice/db/validators"
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

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ConfirmAction } from "~/components/confirm-action"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

export function FeatureForm({
  setDialogOpen,
  defaultValues,
}: {
  setDialogOpen?: (open: boolean) => void
  defaultValues: InsertFeature
}) {
  const router = useRouter()
  const trpc = useTRPC()

  const queryClient = useQueryClient()
  const featureExist = useMutation(trpc.features.exist.mutationOptions())

  const editMode = !!defaultValues.id

  // async validation only when creating a new feature
  const forSchema = editMode
    ? featureInsertBaseSchema
    : featureInsertBaseSchema.extend({
        slug: z
          .string()
          .min(3)
          .refine(async (slug) => {
            // TODO: debounce this
            const { exist } = await featureExist.mutateAsync({
              slug: slug,
            })

            return !exist
          }, "Feature slug already exists in this project. Change the title of your feature."),
      })

  const form = useZodForm({
    schema: forSchema,
    defaultValues,
  })

  const createFeature = useMutation(
    trpc.features.create.mutationOptions({
      onSuccess: async ({ feature }) => {
        form.reset(feature)
        await queryClient.invalidateQueries({
          queryKey: trpc.features.searchBy.queryKey(),
        })
        toastAction("saved", "Feature created")
        setDialogOpen?.(false)
        router.refresh()
      },
    })
  )

  const updateFeature = useMutation(
    trpc.features.update.mutationOptions({
      onSuccess: async ({ feature }) => {
        form.reset(feature)
        await queryClient.invalidateQueries({
          queryKey: trpc.features.searchBy.queryKey(),
        })
        toastAction("updated", "Feature saved")

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
    })
  )

  const deleteFeature = useMutation(
    trpc.features.remove.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.features.searchBy.queryKey(),
        })
        toastAction("deleted", "Feature deleted")
        form.reset()
      },
    })
  )

  function onDelete() {
    startTransition(() => {
      if (!defaultValues.id) return
      void deleteFeature.mutateAsync({ id: defaultValues.id })
    })
  }

  const onSubmitForm = async (data: InsertFeature) => {
    if (!defaultValues.id) {
      await createFeature.mutateAsync(data)
    }

    if (defaultValues.id) {
      await updateFeature.mutateAsync({ ...data, id: defaultValues.id })
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmitForm)} className="space-y-6">
        <div className="space-y-8">
          <div className="flex justify-between gap-2">
            <div className="w-full">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Feature title</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="Custom Domains"
                        onChange={(e) => {
                          field.onChange(e)
                          if (!editMode) {
                            const slug = slugify(e.target.value)
                            form.setValue("slug", slug)
                          }
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="w-full">
              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Feature slug</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="custom-domains" readOnly disabled />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </div>

          <FormField
            control={form.control}
            name="unitOfMeasure"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Unit of measure</FormLabel>
                <FormDescription>
                  Singular unit used in usage, entitlement, and invoice evidence.
                </FormDescription>
                <FormControl>
                  <Input {...field} placeholder="domain" value={field.value} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormDescription>
                  Short description of what customers receive or can use.
                </FormDescription>
                <FormControl>
                  <Textarea
                    {...field}
                    value={field.value ?? ""}
                    placeholder="Grants customers access to custom domains."
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

                // Only needed when the form is inside a uncontrolled dialog - normally updates
                // FIXME: hack to close the dialog when the form is inside a uncontrolled dialog
                if (!setDialogOpen) {
                  const escKeyEvent = new KeyboardEvent("keydown", {
                    key: "Escape",
                  })
                  document.dispatchEvent(escKeyEvent)
                }

                onDelete()
              }}
            >
              <Button variant={"link"} disabled={deleteFeature.isPending}>
                Delete
              </Button>
            </ConfirmAction>
          )}
          <SubmitButton
            isSubmitting={form.formState.isSubmitting}
            isDisabled={form.formState.isSubmitting}
            label={editMode ? "Save feature" : "Create feature"}
          />
        </div>
      </form>
    </Form>
  )
}
