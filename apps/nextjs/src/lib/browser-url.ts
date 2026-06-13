const absoluteUrlPattern = /^[a-z][a-z\d+\-.]*:\/\//i

export function toBrowserAbsoluteUrl(urlOrPath: string, origin = window.location.origin): string {
  if (absoluteUrlPattern.test(urlOrPath)) {
    return urlOrPath
  }

  const normalizedOrigin = origin.endsWith("/") ? origin.slice(0, -1) : origin
  const normalizedPath = urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`

  return `${normalizedOrigin}${normalizedPath}`
}
