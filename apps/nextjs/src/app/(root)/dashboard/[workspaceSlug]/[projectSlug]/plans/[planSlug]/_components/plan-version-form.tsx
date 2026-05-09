"use client"
import { useMutation } from "@tanstack/react-query"
import {
  type InsertPlanVersion,
  getTrialUnitLabel,
  planVersionSelectBaseSchema,
  versionInsertBaseSchema,
} from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Form, FormDescription, FormLabel } from "@unprice/ui/form"
import { cn } from "@unprice/ui/utils"
import { useParams, usePathname, useRouter } from "next/navigation"
import { startTransition } from "react"
import { z } from "zod"
import { ConfirmAction } from "~/components/confirm-action"
import { CopyButton } from "~/components/copy-button"
import AutoRenewFormField from "~/components/forms/autorenew-field"
import BillingConfigFormField from "~/components/forms/billing-config-field"
import CollectionMethodFormField from "~/components/forms/collection-method-field"
import TrialUnitsFormField from "~/components/forms/trial-days-field"
import WhenToBillFormField from "~/components/forms/when-to-bill-field"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"
import { BannerPublishedVersion } from "../[planVersionId]/_components/banner"
import {
  CurrencyFormField,
  DescriptionFormField,
  PaymentProviderFormField,
  TitleFormField,
} from "./version-fields-form"

const isPublishedSchema = planVersionSelectBaseSchema
  .partial()
  .required({
    id: true,
    projectId: true,
    billingConfig: true,
    trialUnits: true,
  })
  .extend({
    isDefault: z.boolean().optional(),
  })

export type PublishedPlanVersion = z.infer<typeof isPublishedSchema>

export function PlanVersionForm({
  setDialogOpen,
  defaultValues,
  className,
}: {
  setDialogOpen?: (open: boolean) => void
  defaultValues: InsertPlanVersion | PublishedPlanVersion
  className?: string
}) {
  const pathname = usePathname()
  const router = useRouter()
  const params = useParams()
  const trpc = useTRPC()

  const editMode = !!defaultValues.id
  const isPublished = defaultValues.status === "published"

  const form = useZodForm({
    schema: versionInsertBaseSchema,
    defaultValues: defaultValues,
  })
  const billingInterval = form.watch("billingConfig.billingInterval")
  const trialUnits = form.watch("trialUnits")
  const trialUnitLabel = billingInterval
    ? getTrialUnitLabel({ billingInterval, units: trialUnits })
    : "days"

  const createPlanVersion = useMutation(
    trpc.planVersions.create.mutationOptions({
      onSuccess: ({ planVersion }) => {
        form.reset(planVersion)
        toastAction("saved")
        setDialogOpen?.(false)
        router.refresh()
        router.push(`${params.planSlug}/${planVersion.id}`)
      },
    })
  )

  const updatePlanVersion = useMutation(
    trpc.planVersions.update.mutationOptions({
      onSuccess: ({ planVersion }) => {
        form.reset(planVersion)
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
    })
  )

  const deletePlanVersion = useMutation(
    trpc.planVersions.remove.mutationOptions({
      onSuccess: ({ planVersion }) => {
        toastAction("deleted")
        setDialogOpen?.(false)
        form.reset()

        if (pathname.includes(planVersion.id)) {
          router.push(pathname.replace(planVersion.id, ""))
        }

        router.refresh()
      },
    })
  )

  const onSubmitForm = async (data: InsertPlanVersion | PublishedPlanVersion) => {
    if (!defaultValues.id && !isPublished) {
      await createPlanVersion.mutateAsync(data as InsertPlanVersion)
    }

    if (defaultValues.id && defaultValues.projectId) {
      await updatePlanVersion.mutateAsync({
        ...data,
        id: defaultValues.id,
        billingConfig: {
          ...data.billingConfig,
          billingAnchor: data.billingConfig.billingAnchor ?? "dayOfCreation",
        },
      })
    }
  }

  function onDelete() {
    startTransition(() => {
      if (!defaultValues.id) {
        toastAction("error", "no data defined")
        return
      }

      void deletePlanVersion.mutateAsync({ id: defaultValues.id })
    })
  }

  return (
    <Form {...form}>
      <form className={cn("space-y-6", className)}>
        {editMode && (
          <div className="flex items-center justify-between">
            <div>
              <FormLabel>Plan Version ID</FormLabel>
              <FormDescription>{defaultValues.id}</FormDescription>
            </div>
            <CopyButton value={defaultValues.id ?? ""} className="size-4" />
          </div>
        )}

        {isPublished && <BannerPublishedVersion />}

        <div className="flex flex-col gap-4 md:grid md:grid-cols-2 md:space-y-4">
          <TitleFormField form={form} isDisabled={isPublished} />

          <CurrencyFormField form={form} isDisabled={isPublished} />

          <CollectionMethodFormField form={form} isDisabled={isPublished} />

          <BillingConfigFormField form={form} isDisabled={isPublished} />

          <TrialUnitsFormField form={form} isDisabled={isPublished} unitLabel={trialUnitLabel} />

          <WhenToBillFormField form={form} isDisabled={isPublished} />

          <AutoRenewFormField form={form} isDisabled={isPublished} />

          <PaymentProviderFormField
            form={form}
            isDisabled={isPublished}
            workspaceSlug={params.workspaceSlug as string}
            projectSlug={params.projectSlug as string}
          />

          <DescriptionFormField form={form} />
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
              <Button variant={"link"} disabled={deletePlanVersion.isPending}>
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
