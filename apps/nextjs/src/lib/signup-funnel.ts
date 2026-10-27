import { APP_DOMAIN, AUTH_ROUTES, BASE_URL } from "@unprice/config"
import { z } from "zod"

export const ACQUISITION_SIGNUP_URL = new URL(AUTH_ROUTES.SIGNUP, APP_DOMAIN).toString()
export const TERMS_URL = new URL("/terms", BASE_URL).toString()
export const PRIVACY_URL = new URL("/privacy", BASE_URL).toString()

type AuthRoute = (typeof AUTH_ROUTES)["SIGNIN" | "SIGNUP"]
const SAFE_NEXT_BASE_URL = new URL("https://safe-next.invalid")
export const signupIntentSchema = z.enum(["paid-action", "budgets"])
export type SignupIntent = z.infer<typeof signupIntentSchema>

/**
 * Where a workspace sends a signup with this intent, or null for the workspace's own home. A
 * Budgets visitor needs a project and a runtime key, not the paid-action proof.
 */
const INTENT_LANDING: Record<SignupIntent, ((workspaceSlug: string) => string) | null> = {
  "paid-action": null,
  budgets: (workspaceSlug) => `/${workspaceSlug}/onboarding/budgets`,
}

/** Workspace creation, carrying the intent so `/new` can route onward once it exists. */
export function newWorkspacePath(intent?: SignupIntent): string {
  return intent ? `/new?${new URLSearchParams({ intent })}` : "/new"
}

/** Where auth continues for this intent: through `/new` when the intent has its own landing. */
export function nextAfterAuth(intent: SignupIntent): string | undefined {
  return INTENT_LANDING[intent] ? newWorkspacePath(intent) : undefined
}

/** The intent's own landing inside a workspace, or null when it has none. */
export function intentLanding(workspaceSlug: string, intent?: SignupIntent): string | null {
  return (intent && INTENT_LANDING[intent]?.(workspaceSlug)) || null
}

/** Where a workspace lands a signup with this intent: its own landing, else the workspace. */
export function workspaceLanding(workspaceSlug: string, intent?: SignupIntent): string {
  return intentLanding(workspaceSlug, intent) ?? `/${workspaceSlug}`
}

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

/** Where auth continues: a safe `next` from the link, else the intent's own route through `/new`. */
export function authNextPath(
  next: string | null | undefined,
  intent?: SignupIntent
): string | null {
  return getSafeNextPath(next) ?? (intent ? (nextAfterAuth(intent) ?? null) : null)
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
