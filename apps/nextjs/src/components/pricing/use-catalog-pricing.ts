"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { useTRPC, useTRPCClient } from "~/trpc/client"
import type { CatalogPolicyInput, CatalogPreview, catalogPricingInputOf } from "./catalog-policy"
import { changeMatrixOf, countWrites, describeChanges } from "./rate-card-format"

type PolicyInput = ReturnType<typeof catalogPricingInputOf>
type Target =
  | { planVersionId: string; featureSlug: string }
  | { cardId: string; featureSlug: string }

export function catalogPreviewOf(preview: CatalogPreview | null, featureSlug: string) {
  const changes = preview ? changeMatrixOf(preview.draft, featureSlug) : null
  return {
    changes,
    writes: preview ? countWrites(preview.draft) : 0,
    summary: changes ? describeChanges(changes) : "",
  }
}

/** One preview and reviewed hash per input; reset also invalidates requests still in flight. */
export function useCatalogPricing(target: Target, input?: PolicyInput) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const requestId = useRef(0)
  const reviewedRef = useRef<{ key: string; preview: CatalogPreview } | null>(null)
  const [reviewed, setReviewed] = useState<{ key: string; preview: CatalogPreview } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const key = JSON.stringify([target, input])
  const cardId = "cardId" in target ? target.cardId : ""
  const { data: catalog, isFetching } = useQuery({
    ...trpc.rateCards.previewCostPlus.queryOptions({ cardId, featureSlug: target.featureSlug }),
    enabled: Boolean(cardId),
  })
  const options = { meta: { suppressGlobalError: true } }
  const previewPricing = useMutation({
    ...options,
    mutationFn: (policy: CatalogPolicyInput) => {
      if (!("planVersionId" in target)) throw new Error("A plan version is required")
      return client.rateCards.previewCatalogPricing.query({ ...target, ...policy })
    },
  })
  const applyPricing = useMutation(trpc.rateCards.applyCatalogPricing.mutationOptions(options))
  const publishPricing = useMutation(trpc.rateCards.publishCostPlus.mutationOptions())
  const preview: CatalogPreview | null =
    cardId && catalog?.draftHash
      ? { ...catalog, draftHash: catalog.draftHash, cardId, tieredModels: [] }
      : reviewed?.key === key
        ? reviewed.preview
        : null
  const reset = () => {
    requestId.current += 1
    reviewedRef.current = null
    setReviewed(null)
    setProblem(null)
  }
  const runPreview = async (built: PolicyInput) => {
    const id = ++requestId.current
    reviewedRef.current = null
    setReviewed(null)
    setProblem(null)
    if (JSON.stringify(built) !== JSON.stringify(input)) return
    if (!built.ok) {
      setProblem(built.message)
      return
    }
    try {
      const result = await previewPricing.mutateAsync(built.input)
      if (id === requestId.current) {
        reviewedRef.current = { key, preview: result }
        setReviewed(reviewedRef.current)
      }
    } catch (error) {
      if (id === requestId.current)
        setProblem(error instanceof Error ? error.message : "Preview failed")
    }
  }
  const apply = async (policy: CatalogPolicyInput | { effectiveFrom?: number }) => {
    const approved = cardId
      ? preview
      : reviewedRef.current?.key === key
        ? reviewedRef.current.preview
        : null
    if (!approved?.draftHash) return
    if (
      "planVersionId" in target &&
      (!input?.ok || JSON.stringify(policy) !== JSON.stringify(input.input))
    )
      return
    setProblem(null)
    try {
      const published =
        "planVersionId" in target && "markup" in policy
          ? await applyPricing.mutateAsync({ ...target, ...policy, draftHash: approved.draftHash })
          : "cardId" in target
            ? await publishPricing.mutateAsync({
                ...target,
                ...("effectiveFrom" in policy ? policy : {}),
                draftHash: approved.draftHash,
              })
            : undefined
      if (!published) return
      reset()
      void queryClient.invalidateQueries(trpc.rateCards.forPlanVersion.pathFilter())
      void queryClient.invalidateQueries(trpc.rateCards.get.pathFilter())
      void queryClient.invalidateQueries(trpc.rateCards.previewCostPlus.pathFilter())
      void queryClient.invalidateQueries(trpc.planVersions.getById.pathFilter())
      return published
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Publish failed")
    }
  }
  return {
    preview,
    problem,
    runPreview,
    apply,
    reset,
    ...catalogPreviewOf(preview, target.featureSlug),
    isPreviewing: previewPricing.isPending || isFetching,
    isApplying: applyPricing.isPending || publishPricing.isPending,
  }
}
