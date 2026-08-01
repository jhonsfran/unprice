export function getCanonicalAuthRedirectUrl(url: string, appDomain: string): string {
  const canonicalAppOrigin = new URL(appDomain).origin

  try {
    const destination = new URL(url, appDomain)

    if (destination.origin === canonicalAppOrigin) {
      return destination.toString()
    }
  } catch {
    // Fall through to the canonical application origin.
  }

  return appDomain
}
