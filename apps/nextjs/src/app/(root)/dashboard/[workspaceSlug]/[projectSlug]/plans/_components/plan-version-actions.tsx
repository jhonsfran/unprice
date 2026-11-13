"use client"

import { Button } from "@unprice/ui/button"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { toast } from "@unprice/ui/sonner"
import { usePathname, useRouter } from "next/navigation"
import type { ElementRef } from "react"
import { forwardRef, startTransition } from "react"

import { useMutation } from "@tanstack/react-query"
import { ConfirmAction } from "~/components/confirm-action"
import { useTRPC } from "~/trpc/client"

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

export { PlanVersionDeactivate, PlanVersionDelete, PlanVersionDuplicate }
