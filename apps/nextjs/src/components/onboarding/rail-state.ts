// The single derivation source for the onboarding money-path rail. Every
// station status is computed from onboardjs flowData plus the current moment,
// so a mid-flow reload reconstructs the rail from persisted context alone.
// Precedence per station: failed > settled data > live phase > ghost — data
// always wins over presentation state, so the rail never claims less (or
// more) than what the server confirmed.

export const BUILD_PHASES = ["provider", "plans", "evidence"] as const
export type BuildPhase = (typeof BUILD_PHASES)[number]

export type OnboardingMomentId = "welcome" | "project" | "build" | "receipt"

export type AppliedTemplate = {
  key: string
  label: string
  planId?: string
  planVersionId: string
}

export type OnboardingFlowData = {
  project?: { id?: string; name?: string; slug?: string; defaultCurrency?: string }
  paymentProvider?: string
  planVersionId?: string
  templatePlansCreated?: boolean
  appliedTemplates?: AppliedTemplate[]
  apiKeyId?: string
  customer?: { customerId?: string; name?: string | null; email?: string }
  subscription?: { id?: string }
  usage?: { state: "done" | "skipped"; eventsRecorded?: number; targetCount?: number }
  verification?: { state: "done" | "skipped"; allowed?: boolean; featureSlug?: string }
  seededMetrics?: boolean
  seedMetricsError?: string
  /** Presentation-only: which build phase is in flight right now. */
  buildPhase?: BuildPhase | "done"
  buildError?: { phase: BuildPhase; message: string }
  done?: boolean
}

export type StationStatus = "ghost" | "live" | "done" | "skipped" | "failed" | "denied"

export type StationKey =
  | "project"
  | "provider"
  | "plans"
  | "apikey"
  | "customer"
  | "subscription"
  | "run"
  | "check"

export type RailStation = {
  key: StationKey
  label: string
  fact: string
  status: StationStatus
  subRows?: { label: string; fact: string }[]
}

const GHOST_FACT = "no entry"

const LIVE_FACTS: Record<StationKey, string> = {
  project: "in progress",
  provider: "enabling…",
  plans: "publishing…",
  apikey: "creating…",
  customer: "creating…",
  subscription: "assigning…",
  run: "running…",
  check: "checking…",
}

const LABELS: Record<StationKey, string> = {
  project: "Project",
  provider: "Payment provider",
  plans: "Plan versions",
  apikey: "API key",
  customer: "Customer",
  subscription: "Subscription",
  run: "Budgeted run",
  check: "access.check",
}

export function shortId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 6)}…${id.slice(-4)}`
}

type Settled = {
  fact: string
  status?: "done" | "skipped" | "denied"
  subRows?: RailStation["subRows"]
}

// What the server has confirmed for a station, or null if nothing yet.
function settledEntry(key: StationKey, flowData: OnboardingFlowData): Settled | null {
  switch (key) {
    case "project":
      return flowData.project?.slug ? { fact: flowData.project.slug } : null
    case "provider":
      // The provider name alone: a settled station already says "enabled",
      // and the longer fact truncates against this long label.
      return flowData.paymentProvider ? { fact: flowData.paymentProvider } : null
    case "plans": {
      const templates = flowData.appliedTemplates
      if (templates?.length) {
        return {
          fact: `${templates.length} published`,
          subRows: templates.map((template) => ({
            label: template.label,
            fact: shortId(template.planVersionId),
          })),
        }
      }
      // Older context from a run that predates appliedTemplates persistence.
      if (flowData.templatePlansCreated && flowData.planVersionId) {
        return { fact: "published" }
      }
      return null
    }
    case "apikey":
      return flowData.apiKeyId ? { fact: shortId(flowData.apiKeyId) } : null
    case "customer":
      return flowData.customer?.customerId
        ? { fact: flowData.customer.email ?? shortId(flowData.customer.customerId) }
        : null
    case "subscription":
      return flowData.subscription?.id ? { fact: shortId(flowData.subscription.id) } : null
    case "run": {
      const usage = flowData.usage
      if (!usage) return null
      if (usage.state === "skipped") return { status: "skipped", fact: "skipped · no meter" }
      // Recorded count only: eventsRecorded can exceed targetCount, so a
      // fraction reads as a bug ("6/2 events").
      const events = usage.eventsRecorded ?? 0
      return { fact: `${events} ${events === 1 ? "event" : "events"}` }
    }
    case "check": {
      const verification = flowData.verification
      if (!verification) return null
      if (verification.state === "skipped") return { status: "skipped", fact: "skipped" }
      if (verification.allowed === false) return { status: "denied", fact: "denied" }
      return { fact: "allowed" }
    }
  }
}

// Which build phase writes each station. `seedEvidence` is one real request
// that produces five stations, so those five go live (and fail) together —
// no fabricated per-station sequencing.
const PHASE_FOR_STATION: Record<Exclude<StationKey, "project">, BuildPhase> = {
  provider: "provider",
  plans: "plans",
  apikey: "evidence",
  customer: "evidence",
  subscription: "evidence",
  run: "evidence",
  check: "evidence",
}

export const STATION_KEYS: readonly StationKey[] = [
  "project",
  "provider",
  "plans",
  "apikey",
  "customer",
  "subscription",
  "run",
  "check",
]

export function deriveRailState(
  flowData: OnboardingFlowData | undefined,
  moment: OnboardingMomentId
): RailStation[] {
  const data = flowData ?? {}

  return STATION_KEYS.map((key) => {
    const label = LABELS[key]

    if (key !== "project" && data.buildError?.phase === PHASE_FOR_STATION[key]) {
      return { key, label, status: "failed" as const, fact: "failed" }
    }

    const settled = settledEntry(key, data)
    if (settled) {
      return {
        key,
        label,
        status: settled.status ?? ("done" as const),
        fact: settled.fact,
        subRows: settled.subRows,
      }
    }

    const live =
      key === "project"
        ? moment === "project"
        : moment === "build" && data.buildPhase === PHASE_FOR_STATION[key]
    if (live) {
      return { key, label, status: "live" as const, fact: LIVE_FACTS[key] }
    }

    return { key, label, status: "ghost" as const, fact: GHOST_FACT }
  })
}

export function settledStationCount(stations: RailStation[]): number {
  return stations.filter(
    (station) =>
      station.status === "done" || station.status === "skipped" || station.status === "denied"
  ).length
}
