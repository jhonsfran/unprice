"use client"

import { useCallback, useMemo, useState } from "react"
import type { ReactNode } from "react"
import {
  type EntitlementValidationEvent,
  type VerifyEntitlementInput,
  type VerifyEntitlementResult,
  useEntitlement,
  useValidateEntitlement,
} from "./realtime"

type FeatureCheckInput = Omit<VerifyEntitlementInput, "featureSlug">

export type UseFeatureArgs = {
  slug: string
}

export type UseFeatureResult = {
  slug: string
  entitled: boolean
  allowed: boolean
  usage: number | null
  deniedReason: VerifyEntitlementResult["deniedReason"] | null
  lastValidation: EntitlementValidationEvent | null
  check: (input?: FeatureCheckInput) => Promise<VerifyEntitlementResult>
  isChecking: boolean
  error: Error | null
}

export type UseCheckFeatureInput = {
  slug: string
} & FeatureCheckInput

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error(fallbackMessage)
}

export function useFeature({ slug }: UseFeatureArgs): UseFeatureResult {
  const entitlement = useEntitlement(slug)
  const [pendingCount, setPendingCount] = useState(0)
  const [error, setError] = useState<Error | null>(null)

  const check = useCallback(
    async (input: FeatureCheckInput = {}) => {
      setPendingCount((count) => count + 1)
      setError(null)

      try {
        return await entitlement.validate(input)
      } catch (validationError) {
        const normalizedError = toError(validationError, "Failed to validate feature")
        setError(normalizedError)
        throw normalizedError
      } finally {
        setPendingCount((count) => Math.max(0, count - 1))
      }
    },
    [entitlement]
  )

  return useMemo(
    () => ({
      slug,
      entitled: entitlement.isEntitled,
      allowed: entitlement.isAllowed,
      usage: entitlement.usage,
      deniedReason: entitlement.lastValidation?.deniedReason ?? null,
      lastValidation: entitlement.lastValidation,
      check,
      isChecking: pendingCount > 0,
      error,
    }),
    [check, entitlement, error, pendingCount, slug]
  )
}

export function useCheckFeature() {
  const { validate, isValidating, error, lastValidationEvent } = useValidateEntitlement()

  const check = useCallback(
    async ({ slug, ...input }: UseCheckFeatureInput) => {
      return await validate({
        ...input,
        featureSlug: slug,
      })
    },
    [validate]
  )

  return {
    check,
    isChecking: isValidating,
    error,
    lastValidation: lastValidationEvent,
  }
}

export type FeatureGateProps = {
  slug: string
  fallback?: ReactNode
  children: ReactNode | ((feature: UseFeatureResult) => ReactNode)
}

export function FeatureGate({ slug, fallback = null, children }: FeatureGateProps) {
  const feature = useFeature({ slug })

  if (!feature.allowed) {
    return <>{fallback}</>
  }

  if (typeof children === "function") {
    return <>{children(feature)}</>
  }

  return <>{children}</>
}
