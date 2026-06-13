import { FEATURE_SLUGS } from "@unprice/config"

// TODO: use a proper flag service
export async function entitlementFlag(featureSlug: string): Promise<boolean> {
  if (!featureSlug || featureSlug === "") {
    return true
  }

  const isAvailable =
    Object.values(FEATURE_SLUGS).find((feature) => feature.SLUG === featureSlug)?.AVAILABLE ?? false

  return Promise.resolve(isAvailable)
}
