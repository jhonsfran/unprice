const FIRST_PARTY_ROOTS = ["unprice.dev", "builderai.sh"]
const VERCEL_PREVIEW_HOSTNAME = /^(?:app-|api-)?pr-\d+-unprice\.vercel\.app$/

export const CORS_ALLOW_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const

export const CORS_ALLOW_HEADERS = [
  "Authorization",
  "X-CSRF-Token",
  "X-Requested-With",
  "Accept",
  "Accept-Version",
  "Content-Length",
  "Content-MD5",
  "Content-Type",
  "Date",
  "X-Api-Version",
  "Unprice-Telemetry-Platform",
  "Unprice-Telemetry-Runtime",
  "Unprice-Telemetry-SDK",
  "X-Trpc-Source",
  "Unprice-Request-Id",
  "Unprice-Request-Source",
] as const

function isFirstPartyHostname(hostname: string): boolean {
  return FIRST_PARTY_ROOTS.some((root) => hostname === root || hostname.endsWith(`.${root}`))
}

function isLocalhostHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  )
}

export function getAllowedCorsOrigin(origin: string | null | undefined): string | null {
  if (!origin) {
    return null
  }

  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return null
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null
  }

  if (isLocalhostHostname(url.hostname)) {
    return origin
  }

  if (url.protocol !== "https:") {
    return null
  }

  if (isFirstPartyHostname(url.hostname) || VERCEL_PREVIEW_HOSTNAME.test(url.hostname)) {
    return origin
  }

  return null
}
