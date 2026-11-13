"use client"

import { useMutation } from "@tanstack/react-query"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { toast } from "@unprice/ui/sonner"
import { useStore } from "jotai"
import { useRouter } from "next/navigation"
import { type ElementRef, forwardRef, startTransition } from "react"
import { ConfirmAction } from "~/components/confirm-action"
import { configPlanFeaturesListAtom } from "~/hooks/use-features"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { useVersionPricing } from "./use-version-pricing"

export interface PlanVersionPublishProps extends React.ComponentPropsWithoutRef<"button"> {
  planVersionId: string
  onConfirmAction?: () => void
  classNames?: string
  variant?: "primary" | "custom"
  /** The attached features as the server knows them; with them, the button counts the unpriced ones. */
  features?: readonly { feature: { slug: string; title: string } }[]
  currency?: string
}

export const PlanVersionPublish = forwardRef<ElementRef<"button">, PlanVersionPublishProps>(
  (props, ref) => {
    const { planVersionId, onConfirmAction, classNames, variant = "primary" } = props
    const router = useRouter()
    // Read the atom lazily via the store rather than subscribing — subscribing here causes
    // a "Cannot update a component while rendering a different component" warning when the
    // atom is hydrated by PlanFeatureList further down the tree.
    const store = useStore()
    const trpc = useTRPC()
    // What the confirm names before the server refuses: features without a row on the card.
    const { readiness } = useVersionPricing(planVersionId, props.currency)
    const unpriced = readiness.unpricedFeatureSlugs.map(
      (slug) => props.features?.find((entry) => entry.feature.slug === slug)?.feature.title ?? slug
    )
    const unpricedCount = unpriced.length

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
        message={
          <>
            Once you publish this version, it will be available to your customers. You won't be able
            to edit it anymore.
            {unpriced.length > 0 && (
              <>
                {" "}
                Publishing will be refused until these features are priced:{" "}
                <span className="font-mono text-xs">{unpriced.join(", ")}</span>.
              </>
            )}
          </>
        }
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
          {unpricedCount > 0 && (
            <Badge
              variant="warning"
              className="ml-2 px-1.5 py-0 text-[10px] leading-4"
              aria-label={`${unpricedCount} unpriced features`}
            >
              {unpricedCount}
            </Badge>
          )}
          {publishVersion.isPending && <LoadingAnimation className={"ml-2"} />}
        </Button>
      </ConfirmAction>
    )
  }
)

PlanVersionPublish.displayName = "PlanVersionPublish"
