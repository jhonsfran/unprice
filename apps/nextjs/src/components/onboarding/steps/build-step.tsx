"use client"

import { useOnboarding } from "@onboardjs/react"
import { useMutation } from "@tanstack/react-query"
import { Button } from "@unprice/ui/button"
import { Loader2 } from "lucide-react"
import { useParams } from "next/navigation"
import { useCallback, useEffect, useRef } from "react"

import { SuperLink } from "~/components/super-link"
import { useTRPC } from "~/trpc/client"
import type { BuildPhase, OnboardingFlowData } from "../rail-state"

// The automated stretch of the path: three real requests, run in order with
// no clicks between them. All progress the user sees lives on the rail —
// this component only narrates the current phase and stages recovery when a
// phase fails. Each phase is guarded by the context flags it persists, so a
// retry (or a reload) resumes from the first unfinished phase instead of
// re-running settled ones.

const PHASE_NARRATION: Record<BuildPhase | "done", string> = {
  provider: "Enabling the Sandbox payment provider…",
  plans: "Publishing plan versions…",
  evidence: "Generating synthetic budget evidence…",
  done: "Settled.",
}

const PHASE_ERROR_OPERATION: Record<BuildPhase, string> = {
  provider: "Payment provider could not enable.",
  plans: "Plan versions could not publish.",
  evidence: "Synthetic evidence could not generate.",
}

const SETTLE_BEAT_MS = 400 // duration-deliberate: let the last station ink in

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function normalizeCurrency(currency: string | undefined): "USD" | "EUR" {
  return currency === "EUR" ? "EUR" : "USD"
}

function normalizePaymentProvider(provider: string | undefined): "stripe" | "square" | "sandbox" {
  if (provider === "stripe" || provider === "square") {
    return provider
  }

  return "sandbox"
}

export function BuildStep() {
  const { state, updateContext, next } = useOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const trpc = useTRPC()
  const hasRunRef = useRef(false)

  const flowData = (state?.context?.flowData ?? {}) as OnboardingFlowData

  const setProvider = useMutation(trpc.paymentProvider.setEnabled.mutationOptions())
  const applyPlanTemplate = useMutation(trpc.planVersions.applyTemplate.mutationOptions())
  const seedEvidence = useMutation(trpc.planVersions.seedEvidence.mutationOptions())
  const isBuilding = setProvider.isPending || applyPlanTemplate.isPending || seedEvidence.isPending

  const failPhase = useCallback(
    async (phase: BuildPhase, error: unknown) => {
      await updateContext({
        flowData: {
          buildPhase: undefined,
          buildError: {
            phase,
            message: error instanceof Error ? error.message : "The request failed.",
          },
        },
      })
    },
    [updateContext]
  )

  const runBuild = useCallback(async () => {
    const data = (state?.context?.flowData ?? {}) as OnboardingFlowData
    const project = data.project

    if (!project?.slug) {
      await failPhase("provider", new Error("Missing project data. Return to the previous step."))
      return
    }

    // Phase 1 — payment provider
    let provider = data.paymentProvider
    if (!provider) {
      try {
        await updateContext({ flowData: { buildPhase: "provider", buildError: undefined } })
        const result = await setProvider.mutateAsync({
          paymentProvider: "sandbox",
          enabled: true,
        })
        provider = result.paymentProviderConfig?.paymentProvider ?? "sandbox"
        await updateContext({ flowData: { paymentProvider: provider } })
      } catch (error) {
        await failPhase("provider", error)
        return
      }
    }

    // Phase 2 — plan versions
    let planVersionId = data.planVersionId
    if (!(data.templatePlansCreated && planVersionId)) {
      try {
        await updateContext({ flowData: { buildPhase: "plans", buildError: undefined } })
        const result = await applyPlanTemplate.mutateAsync({
          template: "saas_onboarding",
          currency: normalizeCurrency(project.defaultCurrency),
          paymentProvider: normalizePaymentProvider(provider),
          publish: true,
        })
        planVersionId = result.planVersionId
        await updateContext({
          flowData: {
            planVersionId,
            templatePlansCreated: true,
            appliedTemplates: result.appliedTemplates.map((template) => ({
              key: template.key,
              label: template.label,
              planId: template.planId,
              planVersionId: template.planVersionId,
            })),
          },
        })
      } catch (error) {
        await failPhase("plans", error)
        return
      }
    }

    // Phase 3 — synthetic evidence through the request path
    const hasEvidence = Boolean(
      data.seededMetrics && data.customer?.customerId && data.subscription?.id
    )
    if (!hasEvidence) {
      try {
        await updateContext({ flowData: { buildPhase: "evidence", buildError: undefined } })
        const result = await seedEvidence.mutateAsync({ planVersionId })
        await updateContext({
          flowData: {
            apiKeyId: result.apiKey.id,
            customer: {
              customerId: result.customer.id,
              name: result.customer.name,
              email: result.customer.email,
            },
            subscription: { id: result.subscription.id },
            usage: result.usage,
            verification: result.verification,
            seededMetrics: true,
            seedMetricsError: undefined,
          },
        })
      } catch (error) {
        await failPhase("evidence", error)
        return
      }
    }

    await updateContext({ flowData: { buildPhase: "done" } })
    await wait(SETTLE_BEAT_MS)
    await next()
  }, [
    state?.context?.flowData,
    updateContext,
    next,
    failPhase,
    setProvider,
    applyPlanTemplate,
    seedEvidence,
  ])

  useEffect(() => {
    if (hasRunRef.current) return
    if (!flowData.project?.slug) return

    hasRunRef.current = true
    void runBuild()
  }, [flowData.project?.slug, runBuild])

  const buildError = flowData.buildError
  const phase = flowData.buildPhase

  return (
    <div className="flex w-full max-w-md flex-col items-start gap-6">
      {buildError ? (
        <>
          <div className="w-full rounded-sm border border-danger-border bg-danger-bg p-3">
            <p className="font-medium text-background-textContrast text-sm">
              {PHASE_ERROR_OPERATION[buildError.phase]}
            </p>
            <p className="mt-1 text-background-text text-xs leading-5">{buildError.message}</p>
            <p className="mt-1 text-background-text text-xs leading-5">
              Retry resumes from this station.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Button
              disabled={isBuilding}
              onClick={() => {
                hasRunRef.current = true
                void runBuild()
              }}
            >
              Retry the build
            </Button>
            <SuperLink
              href={`/${workspaceSlug}`}
              className="text-background-text text-xs transition-colors duration-quick ease-out-quad hover:text-background-textContrast"
            >
              Skip for now
            </SuperLink>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2.5">
            <Loader2 aria-hidden className="size-4 animate-spin text-info-text" />
            <p aria-live="polite" className="font-medium text-background-textContrast text-sm">
              {PHASE_NARRATION[phase ?? "provider"]}
            </p>
          </div>
          <p className="text-background-text text-xs leading-5">
            No clicks needed — the rail settles as each response lands.
          </p>
        </>
      )}
    </div>
  )
}
