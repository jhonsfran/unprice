import { type StepComponentProps, useOnboarding } from "@onboardjs/react"
import { useMutation } from "@tanstack/react-query"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTRPC } from "~/trpc/client"

type SeedStepKey = "apikey" | "customer" | "subscription" | "usage" | "verification"
type SeedStepStatus = "pending" | "working" | "done" | "skipped" | "error"

type SeedProgress = Record<SeedStepKey, SeedStepStatus>

const SEED_STEPS: ReadonlyArray<{ key: SeedStepKey; label: string }> = [
  { key: "apikey", label: "Create request-path API key" },
  { key: "customer", label: "Create test customer" },
  { key: "subscription", label: "Assign published plan version" },
  { key: "usage", label: "Run budgeted workflow" },
  { key: "verification", label: "Check customer access" },
] as const

const DEFAULT_PROGRESS: SeedProgress = {
  apikey: "pending",
  customer: "pending",
  subscription: "pending",
  usage: "pending",
  verification: "pending",
}

const RUNNING_PROGRESS: SeedProgress = {
  apikey: "working",
  customer: "working",
  subscription: "working",
  usage: "working",
  verification: "working",
}

function getStatusLabel(status: SeedStepStatus) {
  switch (status) {
    case "working":
      return "Running"
    case "done":
      return "Processed"
    case "skipped":
      return "Skipped"
    case "error":
      return "Failed"
    default:
      return "Queued"
  }
}

export function SeedMetricsStep({ className }: React.ComponentProps<"div"> & StepComponentProps) {
  const { state, updateContext, next } = useOnboarding()
  const trpc = useTRPC()
  const hasRunRef = useRef(false)

  const [progress, setProgress] = useState<SeedProgress>(DEFAULT_PROGRESS)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isComplete, setIsComplete] = useState(false)
  const [usageSkipped, setUsageSkipped] = useState(false)

  const project = (state?.context?.flowData as { project?: { slug: string } })?.project
  const planVersionId = (state?.context?.flowData as { planVersionId?: string })?.planVersionId

  const seedEvidence = useMutation(trpc.planVersions.seedEvidence.mutationOptions())

  const resetState = () => {
    setProgress(DEFAULT_PROGRESS)
    setErrorMessage(null)
    setIsComplete(false)
    setUsageSkipped(false)
  }

  const markSeedFailed = useCallback(
    async (message: string) => {
    setProgress({
      apikey: "error",
      customer: "error",
      subscription: "error",
      usage: "error",
      verification: "error",
    })
    setErrorMessage(message)
    await updateContext({
      flowData: {
        seededMetrics: false,
        seedMetricsError: message,
      },
    })
    },
    [updateContext]
  )
  }

  const runSeed = useCallback(async () => {
    resetState()

    if (!project?.slug || !planVersionId) {
      await markSeedFailed("Missing project or plan data. Please return to the previous step.")
      return
    }

    try {
      setProgress(RUNNING_PROGRESS)

      const result = await seedEvidence.mutateAsync({
        planVersionId,
      })

      setProgress({
        apikey: "done",
        customer: "done",
        subscription: "done",
        usage: result.usage.state,
        verification: result.verification.state,
      })
      setUsageSkipped(result.usage.state === "skipped")

      await updateContext({
        flowData: {
          customer: {
            customerId: result.customer.id,
            name: result.customer.name,
            email: result.customer.email,
          },
          subscription: {
            id: result.subscription.id,
          },
          seededMetrics: true,
          seedMetricsError: undefined,
        },
      })

      setIsComplete(true)
    } catch (error) {
      await markSeedFailed(
        error instanceof Error ? error.message : "Something went wrong while seeding"
      )
    }
  }, [markSeedFailed, planVersionId, project?.slug, seedEvidence, updateContext])

  useEffect(() => {
    if (hasRunRef.current) return
    if (!project?.slug || !planVersionId) return

    hasRunRef.current = true
    void runSeed()
  }, [project?.slug, planVersionId, runSeed])

  const hasError = Object.values(progress).includes("error") || !!errorMessage

  return (
    <div className={cn("flex w-full max-w-xl flex-col gap-6", className)}>
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-10 animate-content items-center justify-center rounded-md bg-primary/10 delay-0!">
          <CheckCircle2 className="size-6 text-primary" />
        </div>
        <h1 className="animate-content font-bold text-2xl delay-0!">Run workflow evidence</h1>
        <p className="animate-content text-muted-foreground text-sm delay-0!">
          We are preparing a test customer, assigning the plan version, starting a budgeted workflow
          run, and checking access.
        </p>
      </div>

      <Card className="animate-content delay-200!">
        <CardHeader>
          <CardTitle className="text-base">Evidence path</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {steps.map((step) => {
            const status = progress[step.key]
            return (
              <div key={step.key} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  {status === "working" && (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  )}
                  {status === "done" && <CheckCircle2 className="h-4 w-4 text-success" />}
                  {status === "skipped" && <AlertTriangle className="h-4 w-4 text-warning" />}
                  {status === "error" && <AlertTriangle className="h-4 w-4 text-destructive" />}
                  {status === "pending" && (
                    <div className="h-2 w-2 rounded-full bg-muted-foreground" />
                  )}
                  <span className="text-foreground text-sm">{step.label}</span>
                </div>
                <span className="text-muted-foreground text-xs">{getStatusLabel(status)}</span>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {usageSkipped && (
        <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-warning text-xs">
          No usage-based features with meter configuration were found. Usage evidence will stay
          empty until you attach one to a plan version.
        </div>
      )}

      {hasError && errorMessage && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive text-xs">
          {errorMessage}
        </div>
      )}

      {isComplete && !hasError && (
        <Button
          className="w-full animate-content delay-200!"
          onClick={async () => {
            await next()
          }}
        >
          Review Sandbox money path
        </Button>
      )}

      {hasError && (
        <Button
          className="w-full animate-content delay-200!"
          onClick={() => {
            hasRunRef.current = false
            void runSeed()
          }}
        >
          Retry evidence setup
        </Button>
      )}
    </div>
  )
}
