import { APP_DOMAIN, AUTH_ROUTES, BASE_URL } from "@unprice/config"
import { z } from "zod"

export const ACQUISITION_SIGNUP_URL = new URL(AUTH_ROUTES.SIGNUP, APP_DOMAIN).toString()
export const TERMS_URL = new URL("/terms", BASE_URL).toString()
export const PRIVACY_URL = new URL("/privacy", BASE_URL).toString()

type AuthRoute = (typeof AUTH_ROUTES)["SIGNIN" | "SIGNUP"]
const SAFE_NEXT_BASE_URL = new URL("https://safe-next.invalid")
export const signupIntentSchema = z.enum(["paid-action"])
export type SignupIntent = z.infer<typeof signupIntentSchema>

export function getSingleSearchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function getSignupIntent(value: string | string[] | undefined): SignupIntent | undefined {
  return signupIntentSchema.safeParse(getSingleSearchParam(value)).data
}

export function getSafeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/")) {
    return null
  }

  try {
    const normalized = decodeURIComponent(next).replace(/\\/g, "/")
    const resolved = new URL(normalized, SAFE_NEXT_BASE_URL)
    if (resolved.origin !== SAFE_NEXT_BASE_URL.origin) {
      return null
    }
  } catch {
    return null
  }

  return next
}

export function buildAuthHref(
  route: AuthRoute,
  { sessionId, intent, next }: { sessionId?: string; intent?: SignupIntent; next?: string | null }
): string {
  const params = new URLSearchParams()

  if (sessionId) {
    params.set("sessionId", sessionId)
  }

  if (intent) {
    params.set("intent", intent)
  }

  const safeNext = getSafeNextPath(next)
  if (safeNext) {
    params.set("next", safeNext)
  }

  const query = params.toString()
  return query ? `${route}?${query}` : route
}

export function createFunnelPageEventClaimer() {
  const claimedPageKeys = new Set<string>()

  return (pageKey: string): boolean => {
    if (claimedPageKeys.has(pageKey)) {
      return false
    }

    claimedPageKeys.add(pageKey)
    return true
  }
}
