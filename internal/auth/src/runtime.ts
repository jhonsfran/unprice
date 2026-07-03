type AuthAppEnv = "development" | "preview" | "production"
type AuthNodeEnv = "development" | "production" | "test"

export function shouldUseSecureAuthCookies(appEnv: AuthAppEnv): boolean {
  return appEnv !== "development"
}

export function shouldTrustAuthHost({
  appEnv,
  nodeEnv,
}: {
  appEnv: AuthAppEnv
  nodeEnv: AuthNodeEnv
}): boolean {
  return nodeEnv === "development" || appEnv !== "development"
}
