import { type StepComponentProps, useOnboarding } from "@onboardjs/react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { API_DOMAIN } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTRPC } from "~/trpc/client"

type SeedStepKey = "apikey" | "customer" | "subscription" | "usage" | "verification"
type SeedStepStatus = "pending" | "working" | "done" | "skipped" | "error"

type SeedProgress = Record<SeedStepKey, SeedStepStatus>
type UsageSeedTarget = {
  featureSlug: string
  eventSlug: string
  aggregationField?: string
}

const DEFAULT_PROGRESS: SeedProgress = {
  apikey: "pending",
  customer: "pending",
  subscription: "pending",
  usage: "pending",
  verification: "pending",
}

function getStatusLabel(status: SeedStepStatus) {
  switch (status) {
    case "working":
      return "In progress"
    case "done":
      return "Done"
    case "skipped":
      return "Skipped"
    case "error":
      return "Failed"
    default:
      return "Pending"
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function SeedMetricsStep({ className }: React.ComponentProps<"div"> & StepComponentProps) {
  const { state, updateContext, next } = useOnboarding()
  const trpc = useTRPC()
  const hasRunRef = useRef(false)

  const [progress, setProgress] = useState<SeedProgress>(DEFAULT_PROGRESS)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isComplete, setIsComplete] = useState(false)

  const project = (
    state?.context?.flowData as {
      project?: { slug: string; timezone?: string; defaultCurrency?: string }
    }
  )?.project
  const planVersionId = (state?.context?.flowData as { planVersionId?: string })?.planVersionId
  const existingApiKey = (state?.context?.flowData as { apiKey?: string })?.apiKey
  const existingCustomer = (state?.context?.flowData as { customer?: { customerId?: string } })
    ?.customer
  const existingSubscription = (state?.context?.flowData as { subscription?: { id?: string } })
    ?.subscription
  const existingSubscriptionId = existingSubscription?.id

  const { data: planVersionData, isLoading: isPlanVersionLoading } = useQuery(
    trpc.planVersions.getById.queryOptions(
      { id: planVersionId ?? "", projectSlug: project?.slug },
      { enabled: !!planVersionId && !!project?.slug }
    )
  )
  const { data: existingSubscriptionData, isLoading: isExistingSubscriptionLoading } = useQuery(
    trpc.subscriptions.getById.queryOptions(
      { id: existingSubscriptionId ?? "" },
      {
        enabled: !!existingSubscriptionId,
        retry: false,
      }
    )
  )

  const createApiKey = useMutation(trpc.apikeys.create.mutationOptions())
  const createCustomer = useMutation(trpc.customers.create.mutationOptions())
  const createSubscription = useMutation(trpc.subscriptions.create.mutationOptions())

  const planFeatures = planVersionData?.planVersion?.planFeatures ?? []

  const usageSeedTargets = useMemo<UsageSeedTarget[]>(() => {
    const targets = new Map<string, UsageSeedTarget>()

    for (const planFeature of planFeatures) {
      if (planFeature.featureType !== "usage") {
        continue
      }

      const meterConfig = planFeature.meterConfig
      if (!meterConfig?.eventSlug) {
        continue
      }

      const featureSlug = planFeature.feature?.slug ?? meterConfig.eventSlug
      const key = `${featureSlug}:${meterConfig.aggregationField ?? "count"}`

      targets.set(key, {
        featureSlug,
        eventSlug: meterConfig.eventSlug,
        aggregationField: meterConfig.aggregationField ?? undefined,
      })
    }

    return Array.from(targets.values())
  }, [planFeatures])

  const verificationFeatureSlug = useMemo(() => planFeatures[0]?.feature?.slug, [planFeatures])

  const setStepStatus = (step: SeedStepKey, status: SeedStepStatus) => {
    setProgress((current) => ({ ...current, [step]: status }))
  }

  const resetState = () => {
    setProgress(DEFAULT_PROGRESS)
    setErrorMessage(null)
    setIsComplete(false)
  }

  const markSeedFailed = (message: string) => {
    setErrorMessage(message)
    updateContext({
      flowData: {
        seededMetrics: false,
        seedMetricsError: message,
      },
    })
  }

  const runSeed = async () => {
    resetState()

    if (!project?.slug || !planVersionId) {
      markSeedFailed("Missing project or plan data. Please return to the previous step.")
      return
    }

    if (!planVersionData?.planVersion) {
      markSeedFailed("Plan version not found. Please return to the previous step.")
      return
    }

    if (planFeatures.length === 0) {
      markSeedFailed("Your plan needs at least one feature before we can seed metrics.")
      return
    }

    let seedFailed = false

    try {
      setStepStatus("apikey", "working")
      let apiKey = existingApiKey

      if (!apiKey) {
        const apiKeyResult = await createApiKey.mutateAsync({
          name: `onboarding-${Date.now()}`,
        })
        apiKey = apiKeyResult.apikey.key ?? ""

        if (!apiKey) {
          setStepStatus("apikey", "error")
          markSeedFailed("Failed to create an API key for seeding metrics.")
          return
        }

        updateContext({
          flowData: {
            apiKey,
          },
        })
      }

      setStepStatus("apikey", "done")

      setStepStatus("customer", "working")
      let customerId = existingCustomer?.customerId

      if (!customerId) {
        const email = `onboarding+${Date.now()}@example.com`
        const defaultCurrency =
          project.defaultCurrency === "EUR" || project.defaultCurrency === "USD"
            ? project.defaultCurrency
            : undefined
        const customerResult = await createCustomer.mutateAsync({
          name: "Onboarding Customer",
          email,
          defaultCurrency,
          timezone: project.timezone ?? "UTC",
          active: true,
        })

        customerId = customerResult.customer.id

        updateContext({
          flowData: {
            customer: {
              customerId: customerResult.customer.id,
              name: customerResult.customer.name,
              email: customerResult.customer.email,
            },
          },
        })
      }

      if (!customerId) {
        setStepStatus("customer", "error")
        markSeedFailed("Failed to create a customer for onboarding.")
        return
      }

      setStepStatus("customer", "done")

      setStepStatus("subscription", "working")
      const now = Date.now()
      const reusableSubscription = existingSubscriptionData?.subscription
      const hasMatchingActivePhase =
        reusableSubscription?.phases.some((phase) => {
          if (phase.planVersionId !== planVersionId) {
            return false
          }
          if (phase.startAt > now) {
            return false
          }
          return !phase.endAt || phase.endAt > now
        }) ?? false
      const reusableSubscriptionId =
        reusableSubscription?.id &&
        reusableSubscription?.customerId === customerId &&
        hasMatchingActivePhase
          ? reusableSubscription.id
          : null

      if (!reusableSubscriptionId) {
        // Backdate phase start a bit to avoid client/server clock skew causing
        // ingestion events to land before the phase grants become active.
        const skewSafeStartAt = now - 5 * 60 * 1000
        const subscriptionResult = await createSubscription.mutateAsync({
          customerId,
          timezone: project.timezone ?? "UTC",
          phases: [
            {
              planVersionId,
              startAt: skewSafeStartAt,
              trialUnits: planVersionData.planVersion.trialUnits ?? 0,
            },
          ],
        })

        updateContext({
          flowData: {
            subscription: {
              id: subscriptionResult.subscription.id,
            },
          },
        })
      } else {
        updateContext({
          flowData: {
            subscription: {
              id: reusableSubscriptionId,
            },
          },
        })
      }

      setStepStatus("subscription", "done")

      if (!usageSeedTargets.length) {
        setStepStatus("usage", "skipped")
      } else {
        let usageFailed = false
        setStepStatus("usage", "working")
        const usageEvents = [12, 8, 5, 18, 22, 14, 9]
        for (const target of usageSeedTargets) {
          for (const usage of usageEvents) {
            const usageResponse = await fetch(`${API_DOMAIN}v1/events/ingest`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                customerId,
                eventSlug: target.eventSlug,
                idempotencyKey: crypto.randomUUID(),
                properties: target.aggregationField ? { [target.aggregationField]: usage } : {},
              }),
            })

            if (usageResponse.status !== 202) {
              usageFailed = true
              seedFailed = true
              const message = await usageResponse.text()
              markSeedFailed(
                `Ingestion events failed to seed for ${target.featureSlug}. ${message ? `Response: ${message}` : ""}`.trim()
              )
              break
            }

            await delay(120)
          }

          if (usageFailed) {
            break
          }
        }

        setStepStatus("usage", usageFailed ? "error" : "done")
      }

      if (!verificationFeatureSlug) {
        setStepStatus("verification", "skipped")
      } else {
        let verificationFailed = false
        setStepStatus("verification", "working")
        const verificationEvents = [1, 1, 1, 1]
        for (const _value of verificationEvents) {
          const verificationResponse = await fetch(`${API_DOMAIN}v1/entitlements/verify`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              customerId,
              featureSlug: verificationFeatureSlug,
            }),
          })

          if (!verificationResponse.ok) {
            verificationFailed = true
            seedFailed = true
            const message = await verificationResponse.text()
            markSeedFailed(
              `Verification events failed to seed. ${message ? `Response: ${message}` : ""}`.trim()
            )
            break
          }

          await delay(150)
        }

        setStepStatus("verification", verificationFailed ? "error" : "done")
      }

      if (seedFailed) {
        setIsComplete(false)
        return
      }

      updateContext({
        flowData: {
          seededMetrics: true,
          seedMetricsError: undefined,
        },
      })

      setIsComplete(true)
    } catch (error) {
      markSeedFailed(error instanceof Error ? error.message : "Something went wrong while seeding")
    }
  }

  useEffect(() => {
    if (hasRunRef.current) return
    if (!project?.slug || !planVersionId) return
    if (isPlanVersionLoading) return
    if (existingSubscriptionId && isExistingSubscriptionLoading) return
    if (!planVersionData?.planVersion) return

    hasRunRef.current = true
    void runSeed()
  }, [
    project?.slug,
    planVersionId,
    isPlanVersionLoading,
    existingSubscriptionId,
    isExistingSubscriptionLoading,
    planVersionData?.planVersion?.id,
  ])

  const steps = [
    { key: "apikey", label: "Create API key" },
    { key: "customer", label: "Create test customer" },
    { key: "subscription", label: "Create subscription" },
    { key: "usage", label: "Send ingestion events" },
    { key: "verification", label: "Send verification events" },
  ] as const

  const hasError = Object.values(progress).includes("error") || !!errorMessage
  const showUsageWarning =
    !!planVersionData?.planVersion && planFeatures.length > 0 && usageSeedTargets.length === 0

  return (
    <div className={cn("flex w-full max-w-xl flex-col gap-6", className)}>
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-10 animate-content items-center justify-center rounded-md bg-primary/10 delay-0!">
          <CheckCircle2 className="size-6 text-primary" />
        </div>
        <h1 className="animate-content font-bold text-2xl delay-0!">Seeding your dashboard</h1>
        <p className="animate-content text-muted-foreground text-sm delay-0!">
          We are creating a test customer and sending sample ingestion + verification events.
        </p>
      </div>

      <Card className="animate-content delay-200!">
        <CardHeader>
          <CardTitle className="text-base">Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
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

      {showUsageWarning && (
        <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-warning text-xs">
          No usage-based features with meter configuration were found. Ingestion metrics will stay
          empty until you add one.
        </div>
      )}

      {hasError && errorMessage && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive text-xs">
          {errorMessage}
        </div>
      )}

      {isComplete && !hasError && (
        <Button className="w-full animate-content delay-200!" onClick={() => next()}>
          Continue
        </Button>
      )}

      {hasError && (
        <div className="flex flex-col gap-2">
          <Button
            className="w-full animate-content delay-200!"
            onClick={() => {
              hasRunRef.current = false
              void runSeed()
            }}
          >
            Retry seeding
          </Button>
          <Button
            variant="ghost"
            className="w-full animate-content delay-200!"
            onClick={() => next()}
          >
            Continue anyway
          </Button>
        </div>
      )}
    </div>
  )
}
