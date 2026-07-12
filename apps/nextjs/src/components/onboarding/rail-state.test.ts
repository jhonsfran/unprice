import { describe, expect, it } from "vitest"

import {
  type OnboardingFlowData,
  deriveRailState,
  settledStationCount,
  shortId,
} from "./rail-state"

const fullData: OnboardingFlowData = {
  project: { slug: "workflow-api-sandbox", defaultCurrency: "USD" },
  paymentProvider: "sandbox",
  planVersionId: "pv_2f8a1b3c4d5e6f70",
  templatePlansCreated: true,
  appliedTemplates: [
    { key: "starter", label: "Starter", planVersionId: "pv_starter_0000000001" },
    { key: "pro", label: "Pro", planVersionId: "pv_pro_00000000000001" },
    { key: "enterprise", label: "Enterprise", planVersionId: "pv_ent_0000000000001" },
  ],
  apiKeyId: "key_1a2b3c4d5e6f7a8b",
  customer: { customerId: "cus_9z8y7x6w5v4u3t2s", email: "test@unprice.dev" },
  subscription: { id: "sub_5t6u7v8w9x0y1z2a" },
  usage: { state: "done", eventsRecorded: 24, targetCount: 24 },
  verification: { state: "done", allowed: true, featureSlug: "runs" },
  seededMetrics: true,
}

function station(stations: ReturnType<typeof deriveRailState>, key: string) {
  const found = stations.find((s) => s.key === key)
  if (!found) throw new Error(`missing station ${key}`)
  return found
}

describe("deriveRailState", () => {
  it("renders every station as a ghost before anything exists", () => {
    const stations = deriveRailState(undefined, "welcome")
    expect(stations).toHaveLength(8)
    for (const s of stations) {
      expect(s.status).toBe("ghost")
      expect(s.fact).toBe("no entry")
    }
    expect(settledStationCount(stations)).toBe(0)
  })

  it("marks only the project live during the project moment", () => {
    const stations = deriveRailState({}, "project")
    expect(station(stations, "project").status).toBe("live")
    expect(station(stations, "project").fact).toBe("in progress")
    expect(stations.filter((s) => s.status === "ghost")).toHaveLength(7)
  })

  it("settles the project from data and lights the provider phase", () => {
    const stations = deriveRailState(
      { project: { slug: "acme-workflows" }, buildPhase: "provider" },
      "build"
    )
    expect(station(stations, "project")).toMatchObject({ status: "done", fact: "acme-workflows" })
    expect(station(stations, "provider")).toMatchObject({ status: "live", fact: "enabling…" })
    expect(station(stations, "plans").status).toBe("ghost")
  })

  it("lights all five evidence stations together during the evidence phase", () => {
    const stations = deriveRailState(
      {
        project: { slug: "acme-workflows" },
        paymentProvider: "sandbox",
        appliedTemplates: fullData.appliedTemplates,
        buildPhase: "evidence",
      },
      "build"
    )
    expect(station(stations, "provider")).toMatchObject({
      status: "done",
      fact: "sandbox",
    })
    expect(station(stations, "plans")).toMatchObject({ status: "done", fact: "3 published" })
    expect(station(stations, "plans").subRows).toHaveLength(3)
    for (const key of ["apikey", "customer", "subscription", "run", "check"]) {
      expect(station(stations, key).status).toBe("live")
    }
  })

  it("settles everything from a complete context (receipt)", () => {
    const stations = deriveRailState(fullData, "receipt")
    expect(settledStationCount(stations)).toBe(8)
    expect(station(stations, "customer").fact).toBe("test@unprice.dev")
    expect(station(stations, "run").fact).toBe("24 events")
    expect(station(stations, "check")).toMatchObject({ status: "done", fact: "allowed" })
  })

  it("reconstructs settled stations from data alone after a reload (no live phase)", () => {
    const { buildPhase: _ignored, ...persisted } = {
      ...fullData,
      usage: undefined,
      verification: undefined,
      apiKeyId: undefined,
      customer: undefined,
      subscription: undefined,
    }
    const stations = deriveRailState(persisted, "build")
    expect(station(stations, "plans").status).toBe("done")
    for (const key of ["apikey", "customer", "subscription", "run", "check"]) {
      expect(station(stations, key).status).toBe("ghost")
    }
    expect(stations.some((s) => s.status === "live")).toBe(false)
  })

  it("states the recorded count even when it exceeds the target", () => {
    const stations = deriveRailState(
      { ...fullData, usage: { state: "done", eventsRecorded: 6, targetCount: 2 } },
      "receipt"
    )
    expect(station(stations, "run").fact).toBe("6 events")
  })

  it("renders a skipped run honestly", () => {
    const stations = deriveRailState(
      { ...fullData, usage: { state: "skipped", eventsRecorded: 0, targetCount: 0 } },
      "receipt"
    )
    expect(station(stations, "run")).toMatchObject({
      status: "skipped",
      fact: "skipped · no meter",
    })
  })

  it("renders a denied check as a business outcome, not a failure", () => {
    const stations = deriveRailState(
      { ...fullData, verification: { state: "done", allowed: false, featureSlug: "runs" } },
      "receipt"
    )
    expect(station(stations, "check")).toMatchObject({ status: "denied", fact: "denied" })
  })

  it("fails only the erroring phase and keeps downstream stations ghost", () => {
    const stations = deriveRailState(
      {
        project: { slug: "acme-workflows" },
        paymentProvider: "sandbox",
        buildError: { phase: "plans", message: "boom" },
      },
      "build"
    )
    expect(station(stations, "provider").status).toBe("done")
    expect(station(stations, "plans").status).toBe("failed")
    for (const key of ["apikey", "customer", "subscription", "run", "check"]) {
      expect(station(stations, key).status).toBe("ghost")
    }
  })

  it("fails all five evidence stations together (one real request)", () => {
    const stations = deriveRailState(
      {
        project: { slug: "acme-workflows" },
        paymentProvider: "sandbox",
        appliedTemplates: fullData.appliedTemplates,
        buildError: { phase: "evidence", message: "boom" },
      },
      "build"
    )
    for (const key of ["apikey", "customer", "subscription", "run", "check"]) {
      expect(station(stations, key).status).toBe("failed")
    }
  })
})

describe("shortId", () => {
  it("keeps short ids intact and middle-truncates long ones", () => {
    expect(shortId("pv_short")).toBe("pv_short")
    expect(shortId("pv_2f8a1b3c4d5e6f70")).toBe("pv_2f8…6f70")
  })
})
