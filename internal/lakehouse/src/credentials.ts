/**
 * Throws when a credential set is only partly configured. Each lakehouse client needs every value
 * of its set and answers `NOT_CONFIGURED` without them, so a set with one value missing would
 * silently disable the client: a deployment sets all of a set's variables or none.
 */
export function assertAllOrNoneConfigured(values: Record<string, string | undefined>): void {
  const names = Object.keys(values)
  const missing = names.filter((name) => !values[name])
  if (missing.length > 0 && missing.length < names.length) {
    throw new Error(
      `${names.join(", ")} must be set together or not at all; missing ${missing.join(", ")}`
    )
  }
}
