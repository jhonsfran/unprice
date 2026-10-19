import type { SdkIdentity, UnpriceOptions } from "./transport"

export interface Telemetry {
  /**
   * Unprice-Telemetry-Sdk
   * @example @unprice/budgets@0.1.0
   */
  sdkVersions: string[]
  /**
   * Unprice-Telemetry-Platform
   * @example cloudflare
   */
  platform: string
  /**
   * Unprice-Telemetry-Runtime
   * @example node@v18
   */
  runtime?: string
}

export function getTelemetry(opts: UnpriceOptions, sdk: SdkIdentity): Telemetry | null {
  let platform = "unknown"
  let runtime = "unknown"
  const sdkVersions = [`${sdk.name}@${sdk.version}`]

  try {
    if (typeof process !== "undefined") {
      if (process.env.UNPRICE_DISABLE_TELEMETRY) {
        return null
      }
      platform = process.env.VERCEL ? "vercel" : process.env.AWS_REGION ? "aws" : "unknown"

      // @ts-expect-error - this is a runtime check
      if (typeof EdgeRuntime !== "undefined") {
        runtime = "edge-light"
      } else {
        runtime = `node@${process.version}`
      }
    }

    if (opts.wrapperSdkVersion) {
      sdkVersions.push(opts.wrapperSdkVersion)
    }
  } catch (_error) {
    return null
  }

  return { platform, runtime, sdkVersions }
}
