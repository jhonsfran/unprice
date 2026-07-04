import { type StepComponentProps, useOnboarding } from "@onboardjs/react"
import { useMutation } from "@tanstack/react-query"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { AlertTriangle, CheckCircle2, Loader2, Route } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTRPC } from "~/trpc/client"

type TemplateStatus = "pending" | "working" | "done" | "error"

type TemplateRow = {
  key: string
  label: string
  summary: string
}

const TEMPLATE_ROWS: TemplateRow[] = [
  {
    key: "starter",
    label: "Starter",
    summary: "One budgeted workflow with run limits.",
  },
  {
    key: "pro",
    label: "Pro",
    summary: "Budgeted workflows with tiered compute pricing.",
  },
  {
    key: "enterprise",
    label: "Enterprise",
    summary: "Annual plan for customer-critical automation.",
  },
]

const createProgressState = (status: TemplateStatus = "pending") =>
  Object.fromEntries(TEMPLATE_ROWS.map((template) => [template.key, status])) as Record<
    string,
    TemplateStatus
  >

function getStatusLabel(status: TemplateStatus) {
  switch (status) {
    case "working":
      return "Publishing"
    case "done":
      return "Published"
    case "error":
      return "Failed"
    default:
      return "Queued"
  }
}

function normalizeCurrency(currency: string | undefined): "USD" | "EUR" {
  return currency === "EUR" ? "EUR" : "USD"
}

function normalizePaymentProvider(provider: string | undefined): "stripe" | "square" | "sandbox" {
  if (provider === "stripe" || provider === "square") {
    return provider
  }

  return "sandbox"
}

export function TemplatePlanStep({ className }: React.ComponentProps<"div"> & StepComponentProps) {
  const { state, updateContext, next } = useOnboarding()
  const trpc = useTRPC()
  const hasRunRef = useRef(false)

  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isComplete, setIsComplete] = useState(false)
  const [progress, setProgress] = useState<Record<string, TemplateStatus>>(createProgressState)

  const project = (
    state?.context?.flowData as { project?: { slug: string; defaultCurrency?: string } }
  )?.project
  const existingPlanVersionId = (state?.context?.flowData as { planVersionId?: string })
    ?.planVersionId
  const templatesCreated =
    (state?.context?.flowData as { templatePlansCreated?: boolean })?.templatePlansCreated ?? false
  const selectedPaymentProvider =
    (state?.context?.flowData as { paymentProvider?: string })?.paymentProvider ?? "sandbox"

  const applyPlanTemplate = useMutation(trpc.planVersions.applyTemplate.mutationOptions())

  const resetState = () => {
    setProgress(createProgressState())
    setErrorMessage(null)
    setIsComplete(false)
  }

  const runTemplate = async () => {
    resetState()

    if (!project?.slug) {
      setErrorMessage("Missing project data. Please return to the previous step.")
      return
    }

    if (templatesCreated && existingPlanVersionId) {
      setProgress(createProgressState("done"))
      setIsComplete(true)
      return
    }

    try {
      setProgress(createProgressState("working"))

      const result = await applyPlanTemplate.mutateAsync({
        template: "saas_onboarding",
        currency: normalizeCurrency(project.defaultCurrency),
        paymentProvider: normalizePaymentProvider(selectedPaymentProvider),
        publish: true,
      })

      await updateContext({
        flowData: {
          planVersionId: result.planVersionId,
          templatePlansCreated: true,
        },
      })
      setProgress(createProgressState("done"))
      setIsComplete(true)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Plan template could not publish")
      setProgress(createProgressState("error"))
    }
  }

  useEffect(() => {
    if (hasRunRef.current) return
    if (!project?.slug) return

    hasRunRef.current = true
    void runTemplate()
  }, [project?.slug])

  const hasError = Object.values(progress).includes("error") || !!errorMessage
  const templateRows = useMemo(
    () =>
      TEMPLATE_ROWS.map((template) => ({
        ...template,
        status: progress[template.key] ?? "pending",
      })),
    [progress]
  )

  return (
    <div className={cn("flex w-full max-w-xl flex-col gap-6", className)}>
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-10 animate-content items-center justify-center rounded-md bg-primary/10 delay-0!">
          <Route className="size-6 text-primary" />
        </div>
        <h1 className="animate-content font-bold text-2xl delay-0!">Publish plan versions</h1>
        <p className="animate-content text-muted-foreground text-sm delay-0!">
          We are turning the template into three published plans for your Sandbox project.
        </p>
      </div>

      <Card className="animate-content delay-200!">
        <CardHeader>
          <CardTitle className="text-base">Plan version path</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {templateRows.map((template) => (
            <div key={template.key} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                {template.status === "working" && (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                )}
                {template.status === "done" && <CheckCircle2 className="h-4 w-4 text-success" />}
                {template.status === "error" && (
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                )}
                {template.status === "pending" && (
                  <div className="h-2 w-2 rounded-full bg-muted-foreground" />
                )}
                <div className="flex flex-col">
                  <span className="text-foreground text-sm">{template.label}</span>
                  <span className="text-muted-foreground text-xs">{template.summary}</span>
                </div>
              </div>
              <span className="text-muted-foreground text-xs">
                {getStatusLabel(template.status)}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

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
          Continue to usage evidence
        </Button>
      )}

      {hasError && (
        <Button
          className="w-full animate-content delay-200!"
          onClick={() => {
            hasRunRef.current = false
            void runTemplate()
          }}
        >
          Retry plan publishing
        </Button>
      )}
    </div>
  )
}
