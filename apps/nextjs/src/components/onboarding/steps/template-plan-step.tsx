import { type StepComponentProps, useOnboarding } from "@onboardjs/react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { slugify } from "@unprice/db/utils"
import type {
  AggregationMethod,
  Currency,
  Event,
  Feature,
  PaymentProvider,
} from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import * as currencies from "dinero.js/currencies"
import { AlertTriangle, CheckCircle2, Loader2, Sparkles } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTRPC } from "~/trpc/client"

type TemplateStatus = "pending" | "working" | "done" | "error"

const AGGREGATION_METHODS_WITHOUT_FIELD = new Set<AggregationMethod>(["count"])
const ONBOARDING_USAGE_EVENT_SLUG = "onboarding_usage_ingestion"
const ONBOARDING_USAGE_EVENT_NAME = "Onboarding Usage Ingestion"

type UsageTier = {
  firstUnit: number
  lastUnit: number | null
  unitPrice: string
}

type UsageConfig =
  | {
      mode: "unit"
      price: string
      limit?: number
      aggregationMethod?: "sum" | "latest"
    }
  | {
      mode: "tier"
      tiers: UsageTier[]
      limit?: number
      aggregationMethod?: "sum" | "latest"
    }

type FlatFeature = {
  title: string
  slug: string
  description: string
  unitOfMeasure: string
}

type SeatPackConfig = {
  price: string
  units: number
}

type TemplatePlan = {
  key: string
  label: string
  summary: string
  plan: {
    title: string
    slug: string
    description: string
  }
  billingConfig: {
    name: string
    interval: "month" | "year"
    intervalCount: number
  }
  baseFee: string
  seatPack?: SeatPackConfig
  usage: {
    title: string
    slug: string
    description: string
    unitOfMeasure: string
    config: UsageConfig
  }
  flatFeatures: FlatFeature[]
}

const BASE_FEE_FEATURE: FlatFeature = {
  title: "Pro Access",
  slug: "pro-access",
  description: "Base access fee for the plan.",
  unitOfMeasure: "access",
}

const SEAT_FEATURE: FlatFeature = {
  title: "Seats",
  slug: "seats",
  description: "Seat-based access for the plan.",
  unitOfMeasure: "seat",
}

const CREDITS_FEATURE: FlatFeature = {
  title: "Credits",
  slug: "credits",
  description: "Daily credits that reset automatically.",
  unitOfMeasure: "credit",
}

const TEMPLATE_PLANS: TemplatePlan[] = [
  {
    key: "starter",
    label: "STARTER",
    summary: "Seat packs with simple usage metering.",
    plan: {
      title: "STARTER",
      slug: "starter",
      description: "Seat-based plan with metered usage.",
    },
    billingConfig: {
      name: "monthly",
      interval: "month",
      intervalCount: 1,
    },
    baseFee: "39",
    seatPack: {
      price: "9",
      units: 5,
    },
    usage: {
      title: "API Calls",
      slug: "api-calls",
      description: "Metered API requests.",
      unitOfMeasure: "call",
      config: {
        mode: "unit",
        price: "0.01",
        limit: 5000,
      },
    },
    flatFeatures: [
      {
        title: "Priority Support",
        slug: "priority-support",
        description: "Email + chat support.",
        unitOfMeasure: "support",
      },
      {
        title: "Custom Domains",
        slug: "custom-domains",
        description: "Bring your own domain.",
        unitOfMeasure: "domain",
      },
    ],
  },
  {
    key: "growth",
    label: "GROWTH",
    summary: "Seat packs plus tiered usage for growth teams.",
    plan: {
      title: "GROWTH",
      slug: "growth",
      description: "Balanced pricing with tiered usage.",
    },
    billingConfig: {
      name: "monthly",
      interval: "month",
      intervalCount: 1,
    },
    baseFee: "79",
    seatPack: {
      price: "15",
      units: 5,
    },
    usage: {
      title: "Events",
      slug: "events",
      description: "Tracked product events.",
      unitOfMeasure: "event",
      config: {
        mode: "tier",
        tiers: [
          { firstUnit: 1, lastUnit: 10000, unitPrice: "0.02" },
          { firstUnit: 10001, lastUnit: 100000, unitPrice: "0.015" },
          { firstUnit: 100001, lastUnit: null, unitPrice: "0.01" },
        ],
      },
    },
    flatFeatures: [
      {
        title: "SSO",
        slug: "sso",
        description: "Single sign-on.",
        unitOfMeasure: "sso",
      },
      {
        title: "Audit Logs",
        slug: "audit-logs",
        description: "Detailed audit history.",
        unitOfMeasure: "log",
      },
    ],
  },
  {
    key: "enterprise",
    label: "ENTERPRISE",
    summary: "Annual enterprise plan with seat-based pricing.",
    plan: {
      title: "ENTERPRISE",
      slug: "enterprise",
      description: "Annual plan with seat-based access and enterprise add-ons.",
    },
    billingConfig: {
      name: "annual",
      interval: "year",
      intervalCount: 1,
    },
    baseFee: "1200",
    usage: {
      title: "Seats",
      slug: "seats",
      description: "Active seats billed annually.",
      unitOfMeasure: "seat",
      config: {
        mode: "unit",
        price: "20",
        limit: 500,
        aggregationMethod: "latest",
      },
    },
    flatFeatures: [
      {
        title: "Dedicated CSM",
        slug: "dedicated-csm",
        description: "A dedicated customer success manager.",
        unitOfMeasure: "csm",
      },
      {
        title: "Custom SLAs",
        slug: "custom-sla",
        description: "Enterprise SLA guarantees.",
        unitOfMeasure: "sla",
      },
    ],
  },
]

const createProgressState = () =>
  Object.fromEntries(TEMPLATE_PLANS.map((template) => [template.key, "pending"])) as Record<
    string,
    TemplateStatus
  >

function toDineroPrice(amount: string, currency: string) {
  const currencyConfig = currencies[currency as keyof typeof currencies] ?? currencies.USD
  const precision = amount.split(".")[1]?.length ?? currencyConfig.exponent
  const amountNum = Math.round(Number(amount) * 10 ** precision)

  return {
    dinero: {
      amount: amountNum,
      currency: currencyConfig,
      scale: precision,
    },
    displayAmount: amount,
  }
}

function toUsageAggregationField(featureSlug: string) {
  return `usage_${slugify(featureSlug).replace(/-/g, "_")}`
}

function getStatusLabel(status: TemplateStatus) {
  switch (status) {
    case "working":
      return "In progress"
    case "done":
      return "Done"
    case "error":
      return "Failed"
    default:
      return "Pending"
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function TemplatePlanStep({ className }: React.ComponentProps<"div"> & StepComponentProps) {
  const { state, updateContext, next } = useOnboarding()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const hasRunRef = useRef(false)
  const featureCacheRef = useRef(new Map<string, Feature>())

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

  const currency = project?.defaultCurrency ?? "USD"

  const createPlan = useMutation(trpc.plans.create.mutationOptions())
  const createPlanVersion = useMutation(trpc.planVersions.create.mutationOptions())
  const createFeature = useMutation(trpc.features.create.mutationOptions())
  const createEvent = useMutation(trpc.events.create.mutationOptions())
  const updateEvent = useMutation(trpc.events.update.mutationOptions())
  const createPlanVersionFeature = useMutation(trpc.planVersionFeatures.create.mutationOptions())
  const publishPlanVersion = useMutation(trpc.planVersions.publish.mutationOptions())
  const eventCacheRef = useRef(new Map<string, Event>())

  const resetState = () => {
    setProgress(createProgressState())
    setErrorMessage(null)
    setIsComplete(false)
  }

  const setTemplateStatus = (key: string, status: TemplateStatus) => {
    setProgress((current) => ({ ...current, [key]: status }))
  }

  const getOrCreatePlan = async (plan: TemplatePlan["plan"]) => {
    try {
      const result = await createPlan.mutateAsync({
        title: plan.title,
        slug: plan.slug,
        description: plan.description,
        defaultPlan: false,
      })
      return result.plan
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create plan"

      if (!project?.slug) {
        throw new Error(message)
      }

      const planResult = await queryClient.fetchQuery(
        trpc.plans.getBySlug.queryOptions({ slug: plan.slug })
      )

      if (!planResult.plan?.id) {
        throw new Error(message)
      }

      return planResult.plan
    }
  }

  const getOrCreateFeature = async (feature: FlatFeature) => {
    const cached = featureCacheRef.current.get(feature.slug)
    if (cached?.id) {
      return cached
    }

    try {
      const featureResult = await queryClient.fetchQuery(
        trpc.features.getBySlug.queryOptions({ slug: feature.slug })
      )

      if (featureResult.feature?.id) {
        featureCacheRef.current.set(feature.slug, featureResult.feature)
        return featureResult.feature
      }
    } catch {
      // Ignore and try to create
    }

    try {
      const result = await createFeature.mutateAsync(feature)
      featureCacheRef.current.set(feature.slug, result.feature)
      return result.feature
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create feature"
      const featureResult = await queryClient.fetchQuery(
        trpc.features.getBySlug.queryOptions({ slug: feature.slug })
      )

      if (!featureResult.feature?.id) {
        throw new Error(message)
      }

      featureCacheRef.current.set(feature.slug, featureResult.feature)
      return featureResult.feature
    }
  }

  const getOrCreateEvent = async ({
    slug,
    name,
    availableProperties = [],
  }: {
    slug: string
    name: string
    availableProperties?: string[]
  }) => {
    const cached = eventCacheRef.current.get(slug)
    const normalizedProperties = Array.from(new Set(availableProperties.filter(Boolean)))

    if (cached?.id) {
      const cachedProperties = cached.availableProperties ?? []
      const mergedCachedProperties = Array.from(
        new Set([...cachedProperties, ...normalizedProperties])
      )

      if (mergedCachedProperties.length !== cachedProperties.length) {
        const result = await updateEvent.mutateAsync({
          id: cached.id,
          name: cached.name,
          availableProperties: mergedCachedProperties,
        })

        eventCacheRef.current.set(slug, result.event)
        return result.event
      }

      return cached
    }

    const existingEvents = await queryClient.fetchQuery(
      trpc.events.listByActiveProject.queryOptions()
    )
    const existingEvent = existingEvents.events.find((event) => event.slug === slug)

    if (existingEvent?.id) {
      const mergedProperties = Array.from(
        new Set([...(existingEvent.availableProperties ?? []), ...normalizedProperties])
      )

      if (mergedProperties.length !== (existingEvent.availableProperties ?? []).length) {
        const result = await updateEvent.mutateAsync({
          id: existingEvent.id,
          name: existingEvent.name,
          availableProperties: mergedProperties,
        })

        eventCacheRef.current.set(slug, result.event)
        return result.event
      }

      eventCacheRef.current.set(slug, existingEvent)
      return existingEvent
    }

    const result = await createEvent.mutateAsync({
      name,
      slug,
      availableProperties: normalizedProperties.length ? normalizedProperties : undefined,
    })

    eventCacheRef.current.set(slug, result.event)
    return result.event
  }

  const buildMeterConfig = async ({
    featureSlug,
    aggregationMethod,
  }: {
    featureSlug: string
    aggregationMethod: AggregationMethod
  }) => {
    const aggregationField = AGGREGATION_METHODS_WITHOUT_FIELD.has(aggregationMethod)
      ? undefined
      : toUsageAggregationField(featureSlug)

    const event = await getOrCreateEvent({
      slug: ONBOARDING_USAGE_EVENT_SLUG,
      name: ONBOARDING_USAGE_EVENT_NAME,
      availableProperties: aggregationField ? [aggregationField] : [],
    })

    return {
      eventId: event.id,
      eventSlug: event.slug,
      aggregationMethod,
      ...(aggregationField ? { aggregationField } : {}),
    }
  }

  const runTemplate = async () => {
    resetState()

    if (!project?.slug) {
      setErrorMessage("Missing project data. Please return to the previous step.")
      return
    }

    if (templatesCreated && existingPlanVersionId) {
      setProgress(
        Object.fromEntries(TEMPLATE_PLANS.map((template) => [template.key, "done"])) as Record<
          string,
          TemplateStatus
        >
      )
      setIsComplete(true)
      return
    }

    try {
      const baseFeeFeature = await getOrCreateFeature(BASE_FEE_FEATURE)
      const creditsFeature = await getOrCreateFeature(CREDITS_FEATURE)
      let hasSetPlanVersion = false

      for (const [index, template] of TEMPLATE_PLANS.entries()) {
        setTemplateStatus(template.key, "working")

        const plan = await getOrCreatePlan(template.plan)
        const planVersionResult = await createPlanVersion.mutateAsync({
          planId: plan.id,
          title: template.plan.title,
          description: template.plan.description,
          currency: currency as Currency,
          paymentProvider: selectedPaymentProvider as PaymentProvider,
          paymentMethodRequired: true,
          whenToBill: "pay_in_advance",
          autoRenew: true,
          trialUnits: 0,
          billingConfig: {
            name: template.billingConfig.name,
            billingInterval: template.billingConfig.interval,
            billingIntervalCount: template.billingConfig.intervalCount,
            billingAnchor: "dayOfCreation",
            planType: "recurring",
          },
        })

        const planVersion = planVersionResult.planVersion

        if (!hasSetPlanVersion) {
          hasSetPlanVersion = true
          updateContext({
            flowData: {
              planVersionId: planVersion.id,
            },
          })
        }

        const seatFeatureNeeded = template.seatPack || template.usage.slug === SEAT_FEATURE.slug
        const seatFeature = seatFeatureNeeded ? await getOrCreateFeature(SEAT_FEATURE) : null

        await createPlanVersionFeature.mutateAsync({
          planVersionId: planVersion.id,
          featureId: baseFeeFeature.id,
          featureType: "flat",
          config: {
            price: toDineroPrice(template.baseFee, currency),
          },
          order: 1024,
          billingConfig: planVersion.billingConfig,
          resetConfig: {
            name: planVersion.billingConfig.name,
            resetInterval: planVersion.billingConfig.billingInterval,
            resetIntervalCount: planVersion.billingConfig.billingIntervalCount,
            resetAnchor: planVersion.billingConfig.billingAnchor,
            planType: planVersion.billingConfig.planType,
          },
          defaultQuantity: 1,
          metadata: {
            hidden: true,
          },
        })

        if (template.seatPack && seatFeature) {
          await createPlanVersionFeature.mutateAsync({
            planVersionId: planVersion.id,
            featureId: seatFeature.id,
            featureType: "package",
            config: {
              price: toDineroPrice(template.seatPack.price, currency),
              units: template.seatPack.units,
            },
            order: 2048,
            billingConfig: planVersion.billingConfig,
            resetConfig: {
              name: planVersion.billingConfig.name,
              resetInterval: planVersion.billingConfig.billingInterval,
              resetIntervalCount: planVersion.billingConfig.billingIntervalCount,
              resetAnchor: planVersion.billingConfig.billingAnchor,
              planType: planVersion.billingConfig.planType,
            },
            defaultQuantity: 1,
            limit: template.seatPack.units,
          })
        }

        for (const [index, flatFeature] of template.flatFeatures.entries()) {
          const feature = await getOrCreateFeature(flatFeature)
          await createPlanVersionFeature.mutateAsync({
            planVersionId: planVersion.id,
            featureId: feature.id,
            featureType: "flat",
            config: {
              price: toDineroPrice("0", currency),
            },
            order: 3072 + index * 1024,
            billingConfig: planVersion.billingConfig,
            resetConfig: {
              name: planVersion.billingConfig.name,
              resetInterval: planVersion.billingConfig.billingInterval,
              resetIntervalCount: planVersion.billingConfig.billingIntervalCount,
              resetAnchor: planVersion.billingConfig.billingAnchor,
              planType: planVersion.billingConfig.planType,
            },
            defaultQuantity: 1,
          })
        }

        const usageFeature =
          seatFeature && template.usage.slug === SEAT_FEATURE.slug
            ? seatFeature
            : await getOrCreateFeature({
                title: template.usage.title,
                slug: template.usage.slug,
                description: template.usage.description,
                unitOfMeasure: template.usage.unitOfMeasure,
              })

        const usageAggregationMethod = template.usage.config.aggregationMethod ?? "sum"
        const usageMeterConfig = await buildMeterConfig({
          featureSlug: usageFeature.slug,
          aggregationMethod: usageAggregationMethod,
        })

        if (template.usage.config.mode === "unit") {
          await createPlanVersionFeature.mutateAsync({
            planVersionId: planVersion.id,
            featureId: usageFeature.id,
            featureType: "usage",
            config: {
              usageMode: "unit",
              price: toDineroPrice(template.usage.config.price, currency),
            },
            order: 6144,
            billingConfig: planVersion.billingConfig,
            resetConfig: {
              name: planVersion.billingConfig.name,
              resetInterval: planVersion.billingConfig.billingInterval,
              resetIntervalCount: planVersion.billingConfig.billingIntervalCount,
              resetAnchor: planVersion.billingConfig.billingAnchor,
              planType: planVersion.billingConfig.planType,
            },
            defaultQuantity: 1,
            limit: template.usage.config.limit,
            meterConfig: usageMeterConfig,
          })
        } else {
          await createPlanVersionFeature.mutateAsync({
            planVersionId: planVersion.id,
            featureId: usageFeature.id,
            featureType: "usage",
            config: {
              usageMode: "tier",
              tierMode: "graduated",
              tiers: template.usage.config.tiers.map((tier) => ({
                firstUnit: tier.firstUnit,
                lastUnit: tier.lastUnit,
                unitPrice: toDineroPrice(tier.unitPrice, currency),
                flatPrice: toDineroPrice("0", currency),
              })),
            },
            order: 6144,
            billingConfig: planVersion.billingConfig,
            resetConfig: {
              name: planVersion.billingConfig.name,
              resetInterval: planVersion.billingConfig.billingInterval,
              resetIntervalCount: planVersion.billingConfig.billingIntervalCount,
              resetAnchor: planVersion.billingConfig.billingAnchor,
              planType: planVersion.billingConfig.planType,
            },
            defaultQuantity: 1,
            limit: template.usage.config.limit,
            meterConfig: usageMeterConfig,
          })
        }

        const creditsMeterConfig = await buildMeterConfig({
          featureSlug: creditsFeature.slug,
          aggregationMethod: "sum",
        })

        await createPlanVersionFeature.mutateAsync({
          planVersionId: planVersion.id,
          featureId: creditsFeature.id,
          featureType: "usage",
          config: {
            usageMode: "unit",
            price: toDineroPrice("1", currency),
          },
          order: 7168,
          billingConfig: planVersion.billingConfig,
          resetConfig: {
            name: "daily",
            resetInterval: "day",
            resetIntervalCount: 1,
            resetAnchor: "dayOfCreation",
            planType: planVersion.billingConfig.planType,
          },
          defaultQuantity: 1,
          limit: 100,
          meterConfig: creditsMeterConfig,
        })

        await publishPlanVersion.mutateAsync({
          id: planVersion.id,
        })

        setTemplateStatus(template.key, "done")

        if (index < TEMPLATE_PLANS.length - 1) {
          await delay(700)
        }
      }

      updateContext({
        flowData: {
          templatePlansCreated: true,
        },
      })
      setIsComplete(true)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to create template plans")
      setProgress((current) => {
        const updated = { ...current }
        Object.keys(updated).forEach((key) => {
          if (updated[key] === "working") {
            updated[key] = "error"
          }
        })
        return updated
      })
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
      TEMPLATE_PLANS.map((template) => ({
        ...template,
        status: progress[template.key] ?? "pending",
      })),
    [progress]
  )

  return (
    <div className={cn("flex w-full max-w-xl flex-col gap-6", className)}>
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-10 animate-content items-center justify-center rounded-md bg-primary/10 delay-0!">
          <Sparkles className="size-6 text-primary" />
        </div>
        <h1 className="animate-content font-bold text-2xl delay-0!">Template plans</h1>
        <p className="animate-content text-muted-foreground text-sm delay-0!">
          We are generating a few plan examples with seats, flat add-ons, and usage-based billing.
        </p>
      </div>

      <Card className="animate-content delay-200!">
        <CardHeader>
          <CardTitle className="text-base">Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
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
              void runTemplate()
            }}
          >
            Retry templates
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
