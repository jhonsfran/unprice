"use client"

import { useRouter } from "next/navigation"
import { startTransition } from "react"
import { z } from "zod"

import type { InsertPlan } from "@unprice/db/validators"
import { planInsertBaseSchema } from "@unprice/db/validators"
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
import { Switch } from "@unprice/ui/switch"
import { Textarea } from "@unprice/ui/text-area"

import { useMutation } from "@tanstack/react-query"
import { slugify } from "@unprice/db/utils"
import { ConfirmAction } from "~/components/confirm-action"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

export function PlanForm({
  setDialogOpen,
  defaultValues,
}: {
  setDialogOpen?: (open: boolean) => void
  defaultValues: InsertPlan
}) {
  const router = useRouter()
  const editMode = !!defaultValues.id
  const trpc = useTRPC()
  const planExist = useMutation(trpc.plans.exist.mutationOptions())

  const formSchema = editMode
    ? planInsertBaseSchema
    : planInsertBaseSchema.extend({
        slug: z
          .string()
          .min(3)
          .refine(async (slug) => {
            const { exist } = await planExist.mutateAsync({
              slug: slug,
            })

            return !exist
          }, "Plan slug already exists in this project."),
      })

  const form = useZodForm({
    schema: formSchema,
    defaultValues: defaultValues,
    reValidateMode: "onSubmit",
  })

  const createPlan = useMutation(
    trpc.plans.create.mutationOptions({
      onSuccess: ({ plan }) => {
        form.reset(plan)
        toastAction("saved", "Plan created")
        setDialogOpen?.(false)
        router.refresh()
        router.push(`plans/${plan.slug}`)
      },
    })
  )

  const updatePlan = useMutation(
    trpc.plans.update.mutationOptions({
      onSuccess: ({ plan }) => {
        form.reset(plan)
        toastAction("updated", "Plan saved")
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

  const deletePlan = useMutation(
    trpc.plans.remove.mutationOptions({
      onSuccess: () => {
        toastAction("deleted", "Plan deleted")

        setDialogOpen?.(false)
        // Only needed when the form is inside a uncontrolled dialog - normally updates
        // FIXME: hack to close the dialog when the form is inside a uncontrolled dialog
        if (!setDialogOpen) {
          const escKeyEvent = new KeyboardEvent("keydown", {
            key: "Escape",
          })
          document.dispatchEvent(escKeyEvent)
        }

        form.reset()
        router.refresh()
      },
    })
  )

  const onSubmitForm = async (data: InsertPlan) => {
    if (!defaultValues.id) {
      await createPlan.mutateAsync(data)
    }

    if (defaultValues.id && defaultValues.projectId) {
      await updatePlan.mutateAsync({
        ...data,
        id: defaultValues.id,
      })
    }
  }

  function onDelete() {
    startTransition(() => {
      if (!defaultValues.id) {
        toastAction("error", "no data defined")
        return
      }

      void deletePlan.mutateAsync({ id: defaultValues.id })
    })
  }

  return (
    <Form {...form}>
      <form className="space-y-6">
        <div className="space-y-5">
          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Plan title</FormLabel>
                <FormDescription>
                  Display name for the commercial package shown in dashboard and hosted page
                  contexts.
                </FormDescription>
                <FormControl>
                  <Input
                    {...field}
                    placeholder="FREE"
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

          <FormField
            control={form.control}
            name="slug"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Plan slug</FormLabel>
                <FormDescription>
                  Stable identifier used by API calls and plan-version URLs.
                </FormDescription>
                <FormControl>
                  <Input {...field} placeholder="free" readOnly disabled />
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
                <FormControl>
                  <Textarea {...field} value={field.value ?? ""} />
                </FormControl>
                <FormDescription>
                  Short description of the package customers can subscribe to.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="defaultPlan"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <FormLabel className="text-base">Default plan</FormLabel>
                  <FormDescription>
                    Assign new customers to this plan when signup does not specify a plan version.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="enterprisePlan"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <FormLabel className="text-base">Enterprise plan</FormLabel>
                  <FormDescription>
                    Hide public price details for plans that require a custom commercial agreement.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>

        <div className="flex justify-end space-x-4">
          {editMode && (
            <ConfirmAction
              confirmAction={() => {
                setDialogOpen?.(false)
                onDelete()
              }}
            >
              <Button variant={"link"} disabled={deletePlan.isPending}>
                Delete
              </Button>
            </ConfirmAction>
          )}
          <SubmitButton
            onClick={() => form.handleSubmit(onSubmitForm)()}
            isSubmitting={form.formState.isSubmitting}
            isDisabled={form.formState.isSubmitting}
            label={editMode ? "Save plan" : "Create plan"}
          />
        </div>
      </form>
    </Form>
  )
}
