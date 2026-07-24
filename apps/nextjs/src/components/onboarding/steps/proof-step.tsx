"use client"

import { useOnboarding } from "@onboardjs/react"
import { useMutation } from "@tanstack/react-query"
import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import { Button } from "@unprice/ui/button"
import { StationDot } from "@unprice/ui/station"
import { cn } from "@unprice/ui/utils"
import { track } from "@vercel/analytics"
import { useParams } from "next/navigation"
import { useCallback, useEffect, useRef } from "react"

import { updateContextCookies } from "~/actions/update-context-cookies"
import { SuperLink } from "~/components/super-link"
import { useTRPC } from "~/trpc/client"
import {
  type OnboardingFlowData,
  PROOF_PHASES,
  type ProofPhase,
  hasCompletedProof,
} from "../paid-action-schema"

const PHASE_LABELS: Record<ProofPhase, string> = {
  sandbox: "Preparing Sandbox",
  paid_action: "Running the paid action",
  guardrail: "Testing the guardrail",
}

const PHASE_ERRORS: Record<ProofPhase, string> = {
  sandbox: "The Sandbox could not be prepared.",
  paid_action: "The paid action proof could not run.",
  guardrail: "The guardrail result could not be verified.",
}

const PROOF_SETTLE_MS = 400
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function ProofStep() {
  const { state, updateContext, next } = useOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const trpc = useTRPC()
  const hasRunRef = useRef(false)
  const flowData = (state?.context?.flowData ?? {}) as OnboardingFlowData

  const createProject = useMutation(trpc.projects.create.mutationOptions())
  const provePaidAction = useMutation(trpc.planVersions.provePaidAction.mutationOptions())
  const isRunning = createProject.isPending || provePaidAction.isPending

  const failPhase = useCallback(
    async (phase: ProofPhase, error: unknown) => {
      await updateContext({
        flowData: {
          proofPhase: phase,
          proofError: {
            phase,
            message: error instanceof Error ? error.message : "The request failed.",
          },
        },
      })
    },
    [updateContext]
  )

  const runProof = useCallback(async () => {
    const data = (state?.context?.flowData ?? {}) as OnboardingFlowData
    const paidAction = data.paidAction

    if (!paidAction) {
      await failPhase("sandbox", new Error("Paid action details are missing. Restart onboarding."))
      return
    }

    if (hasCompletedProof(data)) {
      await next()
      return
    }

    // The Sandbox project is workspace-scoped and mints a fresh project, so it
    // stays a client step guarded by its own slug — the one thing a retry must
    // not duplicate.
    let project = data.project
    if (!project?.slug) {
      try {
        await updateContext({ flowData: { proofPhase: "sandbox", proofError: undefined } })
        const result = await createProject.mutateAsync({
          name: "Paid Action Sandbox",
          url: "https://sandbox.example.com",
          defaultCurrency: "USD",
          timezone: "UTC",
        })
        project = result.project
        await updateContextCookies(workspaceSlug, result.project.slug)
        await updateContext({ flowData: { project: result.project } })
      } catch (error) {
        await failPhase("sandbox", error)
        return
      }
    } else {
      await updateContextCookies(workspaceSlug, project.slug)
    }

    // Everything downstream is idempotent and runs atomically on the server:
    // enable provider → publish the paid-action plan → run the two decisions.
    try {
      await updateContext({ flowData: { proofPhase: "paid_action", proofError: undefined } })
      const result = await provePaidAction.mutateAsync({
        projectSlug: project.slug,
        paidAction,
      })
      await updateContext({
        flowData: {
          paymentProvider: result.paymentProvider,
          planVersionId: result.planVersionId,
          templatePlansCreated: true,
          appliedTemplates: result.appliedTemplates.map((template) => ({
            key: template.key,
            label: template.label,
            planId: template.planId,
            planVersionId: template.planVersionId,
          })),
          apiKeyId: result.apiKey.id,
          customer: {
            customerId: result.customer.id,
            name: result.customer.name,
            email: result.customer.email,
          },
          subscription: { id: result.subscription.id },
          proof: {
            action: result.action,
            decisions: result.decisions,
          },
          proofPhase: "guardrail",
          proofError: undefined,
        },
      })
      track("onboarding_proof_completed")
    } catch (error) {
      await failPhase("paid_action", error)
      return
    }

    await wait(PROOF_SETTLE_MS)
    await updateContext({ flowData: { proofPhase: "done" } })
    await next()
  }, [
    createProject,
    failPhase,
    next,
    provePaidAction,
    state?.context?.flowData,
    updateContext,
    workspaceSlug,
  ])

  useEffect(() => {
    if (hasRunRef.current) return
    hasRunRef.current = true
    void runProof()
  }, [runProof])

  const phase =
    flowData.proofPhase && flowData.proofPhase !== "done" ? flowData.proofPhase : "sandbox"
  const currentIndex = PROOF_PHASES.indexOf(phase)
  const proofError = flowData.proofError

  return (
    <div className="flex w-full flex-col gap-6">
      {/* The proof phases as a station rail — the request path walking to a
          decision, not a progress bar. Current phase pings live, settled
          phases carry a success dot, pending phases stay ghosts. */}
      <ol className="flex flex-col">
        {PROOF_PHASES.map((item, index) => {
          const done = flowData.proofPhase === "done" || index < currentIndex
          const live = item === phase && flowData.proofPhase !== "done"
          const isLast = index === PROOF_PHASES.length - 1

          return (
            <li key={item} className="flex gap-3" aria-current={live ? "step" : undefined}>
              <div className="flex flex-col items-center" aria-hidden>
                <span className="relative flex size-[9px] items-center justify-center">
                  {live ? (
                    <span className="mp-beacon absolute inset-0 rounded-full bg-info" />
                  ) : null}
                  <StationDot
                    variant={done ? "terminal" : live ? "live" : "ghost"}
                    className="relative"
                  />
                </span>
                {!isLast ? (
                  <span
                    className={cn(
                      "w-px flex-1",
                      done ? "bg-success-border" : "bg-background-border"
                    )}
                  />
                ) : null}
              </div>
              <div
                className={cn(
                  "flex flex-1 items-center justify-between gap-2",
                  isLast ? "pb-0" : "pb-5"
                )}
              >
                <span
                  className={cn(
                    "text-sm",
                    done || live
                      ? "font-medium text-background-textContrast"
                      : "text-background-text"
                  )}
                >
                  {PHASE_LABELS[item]}
                </span>
                {done ? (
                  <span className="font-mono text-[10px] text-success-text">done</span>
                ) : live ? (
                  <span className="font-mono text-[10px] text-info-text">running…</span>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>

      {proofError ? (
        <div className="flex flex-col items-start gap-4">
          <Alert variant="destructive">
            <AlertTitle>{PHASE_ERRORS[proofError.phase]}</AlertTitle>
            <AlertDescription>
              <p>{proofError.message}</p>
              <p>Retry resumes from the last confirmed operation.</p>
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap items-center gap-4">
            <Button
              disabled={isRunning}
              onClick={() => {
                hasRunRef.current = true
                void runProof()
              }}
            >
              {isRunning ? "Retrying…" : "Retry"}
            </Button>
            <SuperLink
              href={`/${workspaceSlug}`}
              className="text-background-text text-xs transition-colors duration-quick ease-out-quad hover:text-background-textContrast"
              onClick={() => track("onboarding_skipped", { step: "proof_error" })}
            >
              Skip for now
            </SuperLink>
          </div>
        </div>
      ) : (
        <p aria-live="polite" className="text-background-text text-sm leading-6">
          {phase === "sandbox"
            ? "Creating the project, plan version, meter, and capped test customer."
            : phase === "paid_action"
              ? `Authorizing ${flowData.paidAction?.title ?? "the paid action"} with one action of budget.`
              : "Confirming the identical second request was denied without increasing run spend."}
        </p>
      )}
    </div>
  )
}
