export const DEFAULT_SAMPLE_RATE = 0.1

/**
 * Clamp a configured sample-rate binding to the inclusive range [0, 1],
 * falling back when the value is absent or out of range.
 *
 * Shared by DO log sampling (`DO_LOG_SAMPLE_RATE`) and request-metrics
 * sampling (`METRICS_SAMPLE_RATE`). The env schema types these numeric, but
 * Cloudflare bindings arrive as strings at runtime, so we coerce defensively.
 */
export function resolveSampleRate(
  raw: number | string | undefined | null,
  fallback: number = DEFAULT_SAMPLE_RATE
): number {
  if (raw === undefined || raw === null) return fallback

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return fallback
  }
  return parsed
}
