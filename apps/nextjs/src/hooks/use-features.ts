import { atom, useAtom } from "jotai"

import type { Plan, PlanVersion, PlanVersionFeatureDragDrop } from "@unprice/db/validators"

const configActiveFeatureAtom = atom<PlanVersionFeatureDragDrop | null>(null)

export function useActiveFeature() {
  return useAtom(configActiveFeatureAtom)
}

export const configPlanFeaturesListAtom = atom<PlanVersionFeatureDragDrop[]>([])
export const configActivePlanVersionAtom = atom<PlanVersion | null>(null)
export const configActivePlanAtom = atom<Plan | null>(null)
export const configIsOnboardingAtom = atom<boolean>(false)

export function usePlanFeaturesList() {
  return useAtom(configPlanFeaturesListAtom)
}

export function useIsOnboarding() {
  return useAtom(configIsOnboardingAtom)
}

export function useActivePlanVersion() {
  return useAtom(configActivePlanVersionAtom)
}

export function useActivePlan() {
  return useAtom(configActivePlanAtom)
}
