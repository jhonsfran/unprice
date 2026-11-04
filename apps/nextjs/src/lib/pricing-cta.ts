type Tracker = { trackEvent?: (name: string, payload: Record<string, unknown>) => void }

/**
 * Sends an event through track.js (`window.Unprice`) when the script loaded. A blocked, failed, or
 * slow script leaves it undefined, and tracking must never stop the navigation that follows.
 */
export function trackWebEvent(
  name: string,
  payload: Record<string, unknown>,
  target: { Unprice?: Tracker } | undefined = typeof window === "undefined"
    ? undefined
    : (window as { Unprice?: Tracker })
): void {
  try {
    target?.Unprice?.trackEvent?.(name, payload)
  } catch {
    // analytics only
  }
}

/** A pricing CTA link carrying the clicked plan and page, the only sign-up attribution. */
export function pricingCtaHref(
  ctaLink: string,
  plan: { planVersionId: string; pageId: string }
): string {
  const url = new URL(ctaLink)
  url.searchParams.set("planVersionId", plan.planVersionId)
  url.searchParams.set("pageId", plan.pageId)
  return url.toString()
}
