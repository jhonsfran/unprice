import { FEATURE_SLUGS } from "@unprice/config"
import type { FeatureSlug } from "@unprice/config"

export function useFlags(featureSlug: FeatureSlug): boolean {
  const isAvailable = FEATURE_SLUGS[featureSlug].AVAILABLE
  return isAvailable
}
