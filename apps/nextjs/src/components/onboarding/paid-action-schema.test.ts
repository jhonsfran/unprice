import { describe, expect, it } from "vitest"
import {
  type OnboardingFlowData,
  canCompleteOnboarding,
  derivePaidActionSlugs,
  hasCompletedProof,
  normalizePaidAction,
  paidActionFormSchema,
} from "./paid-action-schema"

const validProof: NonNullable<OnboardingFlowData["proof"]> = {
  action: {
    title: "AI generation",
    featureSlug: "ai-generation",
    eventSlug: "ai_generation",
    unitPriceMinor: 410,
    currency: "USD",
  },
  decisions: [
    {
      sequence: 1,
      accepted: true,
      reason: "accepted",
      consumedAmountMinor: 410,
      remainingAmountMinor: 0,
    },
    {
      sequence: 2,
      accepted: false,
      reason: "insufficient_budget",
      consumedAmountMinor: 410,
      remainingAmountMinor: 0,
    },
  ],
}

describe("paid action onboarding state", () => {
  it("accepts the default paid action and normalizes its price", () => {
    const parsed = paidActionFormSchema.parse({
      title: "AI generation",
      unitPrice: "4.1",
      featureSlug: "ai-generation",
      eventSlug: "ai_generation",
      unitOfMeasure: "action",
    })

    expect(normalizePaidAction(parsed)).toEqual({
      title: "AI generation",
      unitPrice: "4.10",
      featureSlug: "ai-generation",
      eventSlug: "ai_generation",
      unitOfMeasure: "action",
    })
  })

  it("rejects zero, over-precision prices, and invalid feature slugs", () => {
    const base = {
      title: "AI generation",
      featureSlug: "ai-generation",
      eventSlug: "ai_generation",
      unitOfMeasure: "action",
    } as const

    expect(paidActionFormSchema.safeParse({ ...base, unitPrice: "0" }).success).toBe(false)
    expect(paidActionFormSchema.safeParse({ ...base, unitPrice: "4.101" }).success).toBe(false)
    expect(
      paidActionFormSchema.safeParse({
        ...base,
        featureSlug: "AI_generation",
        unitPrice: "4.10",
      }).success
    ).toBe(false)
  })

  it("derives separate feature and event slugs from the action name", () => {
    expect(derivePaidActionSlugs("  Video Render  ")).toEqual({
      featureSlug: "video-render",
      eventSlug: "video_render",
    })
  })

  it("does not complete until a valid denial has been revealed", () => {
    expect(hasCompletedProof({ proof: validProof })).toBe(true)
    expect(canCompleteOnboarding({ proof: validProof })).toBe(false)
    expect(canCompleteOnboarding({ proof: validProof, deniedRevealed: true })).toBe(true)
  })

  it("rejects proof state when the denied request changes spend", () => {
    const proof = {
      ...validProof,
      decisions: [
        validProof.decisions[0],
        {
          ...validProof.decisions[1],
          consumedAmountMinor: 411,
        },
      ] as NonNullable<OnboardingFlowData["proof"]>["decisions"],
    }

    expect(hasCompletedProof({ proof })).toBe(false)
  })
})
