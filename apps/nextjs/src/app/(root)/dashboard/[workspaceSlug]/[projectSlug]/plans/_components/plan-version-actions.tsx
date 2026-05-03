"use client"

import { usePathname, useRouter } from "next/navigation"
import type { ElementRef } from "react"
import { forwardRef, startTransition } from "react"

import { Button } from "@unprice/ui/button"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { toast } from "@unprice/ui/sonner"

import { useMutation } from "@tanstack/react-query"
import { useStore } from "jotai"
import { ConfirmAction } from "~/components/confirm-action"
import { configPlanFeaturesListAtom } from "~/hooks/use-features"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

export interface PlanVersionPublishProps extends React.ComponentPropsWithoutRef<"button"> {
  planVersionId: string
  onConfirmAction?: () => void
  classNames?: string
  variant?: "primary" | "custom"
}

const PlanVersionPublish = forwardRef<ElementRef<"button">, PlanVersionPublishProps>(
  (props, ref) => {
    const { planVersionId, onConfirmAction, classNames, variant = "primary" } = props
    const router = useRouter()
    // Read the atom lazily via the store rather than subscribing — subscribing here causes
    // a "Cannot update a component while rendering a different component" warning when the
    // atom is hydrated by PlanFeatureList further down the tree.
    const store = useStore()
    const trpc = useTRPC()

    const publishVersion = useMutation(
      trpc.planVersions.publish.mutationOptions({
        onSuccess: () => {
          router.refresh()
        },
      })
    )

    function onPublishVersion() {
      startTransition(() => {
        const planFeatures = store.get(configPlanFeaturesListAtom)
        const isValidConfig = Object.values(planFeatures).every((f) => f.id !== undefined)
        if (!isValidConfig) {
          toastAction("error", "There are some features without configuration. try again")
          return
        }

        toast.promise(
          publishVersion
            .mutateAsync({
              id: planVersionId,
            })
            .then(() => {
              onConfirmAction?.()
            }),
          {
            loading: "Publishing...",
            success: "Version published",
          }
        )
      })
    }

    return (
      <ConfirmAction
        message="Once you publish this version, it will be available to your customers. You won't be able to edit it anymore. Are you sure you want to publish this version?"
        title="Do you want to publish this version?"
        confirmAction={() => {
          onPublishVersion()
        }}
      >
        {/* // TODO: create a confetti animation or something in the first version published? */}
        <Button
          ref={ref}
          variant={variant}
          disabled={publishVersion.isPending}
          className={classNames}
        >
          Publish
          {publishVersion.isPending && <LoadingAnimation className={"ml-2"} />}
        </Button>
      </ConfirmAction>
    )
  }
)

PlanVersionPublish.displayName = "PlanVersionPublish"

export interface PlanVersionDuplicateProps extends React.ComponentPropsWithoutRef<"button"> {
  planVersionId: string
  classNames?: string
  onConfirmAction?: () => void
}

const PlanVersionDuplicate = forwardRef<ElementRef<"button">, PlanVersionDuplicateProps>(
  (props, ref) => {
    const { planVersionId, classNames, onConfirmAction } = props
    const router = useRouter()
    const trpc = useTRPC()

    const duplicateVersion = useMutation(
      trpc.planVersions.duplicate.mutationOptions({
        onSuccess: () => {
          router.refresh()
        },
      })
    )

    function onDuplicateVersion() {
      startTransition(() => {
        toast.promise(
          duplicateVersion.mutateAsync({
            id: planVersionId,
          }),
          {
            loading: "Duplicating...",
            success: "Version duplicated",
          }
        )
      })
    }

    return (
      <ConfirmAction
        message="Are you sure you want to duplicate this version?"
        title="Do you want to duplicate this version?"
        confirmAction={() => {
          onConfirmAction?.()
          onDuplicateVersion()
        }}
      >
        <Button
          ref={ref}
          className={classNames}
          variant={"custom"}
          disabled={duplicateVersion.isPending}
        >
          Duplicate version
          {duplicateVersion.isPending && <LoadingAnimation className={"ml-2"} />}
        </Button>
      </ConfirmAction>
    )
  }
)

PlanVersionDuplicate.displayName = "PlanVersionDuplicate"

const PlanVersionDeactivate = forwardRef<ElementRef<"button">, PlanVersionDuplicateProps>(
  (props, ref) => {
    const { planVersionId, classNames, onConfirmAction } = props
    const router = useRouter()
    const trpc = useTRPC()

    const duplicateVersion = useMutation(
      trpc.planVersions.deactivate.mutationOptions({
        onSuccess: () => {
          router.refresh()
        },
      })
    )

    function onDeactivateVersion() {
      startTransition(() => {
        toast.promise(
          duplicateVersion.mutateAsync({
            id: planVersionId,
          }),
          {
            loading: "Deactivating...",
            success: "Version deactivated",
          }
        )
      })
    }

    return (
      <ConfirmAction
        message="Are you sure you want to deactivate this version? This version will no longer be available to your customers."
        confirmAction={() => {
          onConfirmAction?.()
          onDeactivateVersion()
        }}
      >
        <Button
          ref={ref}
          className={classNames}
          variant={"custom"}
          disabled={duplicateVersion.isPending}
        >
          Deactivate version
          {duplicateVersion.isPending && <LoadingAnimation className={"ml-2"} />}
        </Button>
      </ConfirmAction>
    )
  }
)

PlanVersionDeactivate.displayName = "PlanVersionDeactivate"

const PlanVersionDelete = forwardRef<ElementRef<"button">, PlanVersionDuplicateProps>(
  (props, ref) => {
    const { planVersionId, classNames, onConfirmAction } = props
    const router = useRouter()
    const pathname = usePathname()
    const trpc = useTRPC()

    const deleteVersion = useMutation(
      trpc.planVersions.remove.mutationOptions({
        onSuccess: ({ planVersion }) => {
          // Navigate up to the plan overview if we were on this version's page,
          // then refresh to invalidate the RSC cache so the deleted version is
          // no longer shown in the parent versions table.
          if (pathname.includes(planVersion.id)) {
            router.push(pathname.replace(`/${planVersion.id}`, ""))
          }
          router.refresh()
        },
      })
    )

    function onDeleteVersion() {
      startTransition(() => {
        toast.promise(deleteVersion.mutateAsync({ id: planVersionId }), {
          loading: "Deleting...",
          success: "Version deleted",
        })
      })
    }

    return (
      <ConfirmAction
        title="Delete this version?"
        message="This will permanently delete the draft. Customers on other versions are unaffected. This action cannot be undone."
        confirmAction={() => {
          onConfirmAction?.()
          onDeleteVersion()
        }}
      >
        <Button
          ref={ref}
          className={classNames}
          variant={"custom"}
          disabled={deleteVersion.isPending}
        >
          Delete version
          {deleteVersion.isPending && <LoadingAnimation className={"ml-2"} />}
        </Button>
      </ConfirmAction>
    )
  }
)

PlanVersionDelete.displayName = "PlanVersionDelete"

export { PlanVersionDeactivate, PlanVersionDelete, PlanVersionDuplicate, PlanVersionPublish }
