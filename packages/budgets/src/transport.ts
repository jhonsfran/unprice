import createOpenApiClient, { type Client as OpenApiClient } from "openapi-fetch"
import type { BudgetSettleError, SpendSettlement } from "./budgets"
import type { ApiError, ErrorResponse } from "./errors"
import type { ApiResult } from "./result"
import { getTelemetry } from "./telemetry"

export type UnpriceOptions = {
  token: string
} & {
  /**
   * @default https://api.unprice.dev
   */
  baseUrl?: string

  /**
   *
   * By default telemetry data is enabled, and sends:
   * runtime (Node.js / Edge)
   * platform (Node.js / Vercel / AWS)
   * SDK version
   */
  disableTelemetry?: boolean

  /**
   * Retry on network and server errors.
   */
  retry?: {
    /**
     * How many attempts should be made.
     * The maximum number of requests will be `attempts + 1`.
     * `0` means no retries.
     *
     * @default 2
     */
    attempts?: number
    /**
     * Return how many milliseconds to wait until the next attempt is made.
     *
     * @default `(retryCount) => Math.round(Math.exp(retryCount) * 10)),`
     */
    backoff?: (retryCount: number) => number
  }
  /**
   * Customize the `fetch` cache behaviour.
   *
   * @default "no-store"
   */
  cache?: RequestCache

  /**
   * Custom fetch implementation for non-standard runtimes or tests.
   */
  fetch?: (input: Request) => Promise<Response>

  /**
   * Log retry attempts with `console.debug`.
   *
   * @default false
   */
  debug?: boolean

  /**
   * The version of the SDK instantiating this client.
   *
   * This is used for internal metrics and is not covered by semver, and may change at any time.
   *
   * You can leave this blank unless you are building a wrapper around this SDK.
   */
  wrapperSdkVersion?: string

  /**
   * Additional headers to send with the request.
   */
  headers?: Record<string, string>

  /**
   * Keeps the runtime alive for work after the response, such as `waitUntil` from
   * `@vercel/functions` or Cloudflare's `ctx.waitUntil`. With it, `spend` returns once the work
   * finishes and settles in the background.
   */
  waitUntil?: (promise: Promise<unknown>) => void

  /**
   * A background settle that failed. Its hold stays open and counts its full estimate when it
   * expires, so usage can be over-counted, never under-counted.
   */
  onSettleError?: (error: BudgetSettleError) => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isApiError = (value: unknown): value is ApiError => {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.docs === "string" &&
    typeof value.requestId === "string"
  )
}

const isErrorResponse = (value: unknown): value is ErrorResponse => {
  if (!isRecord(value)) {
    return false
  }

  return isApiError(value.error)
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === "string") {
    return error
  }

  return "No response"
}

/** The SDK sending the requests, for `unprice-request-source` and `Unprice-Telemetry-SDK`. */
export type SdkIdentity = {
  /** The package name, e.g. `@unprice/budgets`. */
  name: string
  version: string
  /** The request source's prefix, e.g. `budgets` for `budgets@0.1.0`. */
  source: string
}

type SdkFetchResponse<TData> =
  | { data: TData; error?: never; response: Response }
  | { data?: never; error: unknown; response: Response }

export type Transport<Paths extends object> = {
  openapi: OpenApiClient<Paths>
  toResult: <TData>(
    request: Promise<SdkFetchResponse<TData>>
  ) => Promise<ApiResult<Exclude<TData, undefined>>>
  settlement: SpendSettlement
  retry: {
    attempts: number
    backoff: (retryCount: number) => number
  }
}

/**
 * The requests both SDK clients send: auth and telemetry headers, retries on network and server
 * errors, and every failure as an `ApiError`. Exported for `@unprice/api`, which builds its client
 * on it; not covered by semver.
 */
export function createTransport<Paths extends object>(
  opts: UnpriceOptions,
  sdk: SdkIdentity
): Transport<Paths> {
  /**
   * Even though TypeScript should prevent this, some people still pass undefined or empty strings.
   */
  if (!opts.token) {
    throw new Error(
      "unprice root key must be set, maybe you passed in `undefined` or an empty string?"
    )
  }

  const debug = opts.debug ?? false
  const fetchImpl = opts.fetch ?? ((input: Request) => fetch(input))
  const retry = {
    attempts: opts.retry?.attempts ?? 2,
    backoff: opts.retry?.backoff ?? ((n: number) => Math.round(Math.exp(n) * 10)),
  }

  const fetchWithRetry = async (request: Request): Promise<Response> => {
    let response: Response | null = null
    let err: unknown = null

    for (let attempt = 0; attempt <= retry.attempts; attempt++) {
      try {
        response = await fetchImpl(request.clone())
        err = null
      } catch (error) {
        response = null
        err = error
      }

      if (response && response.status < 500) {
        return response
      }

      if (attempt === retry.attempts) {
        break
      }

      const backoff = retry.backoff(attempt)

      if (debug) {
        const requestId = response?.headers.get("unprice-request-id") ?? "N/A"
        console.debug(
          `attempt ${attempt + 1} of ${retry.attempts + 1} to reach ${
            request.url
          } failed, retrying in ${backoff} ms: status=${response?.status} | ${requestId}`
        )
      }

      await sleep(backoff)
    }

    if (response) {
      return response
    }

    throw err instanceof Error ? err : new Error(getErrorMessage(err))
  }

  const toResult: Transport<Paths>["toResult"] = async (request) => {
    try {
      const response = await request

      if ("error" in response) {
        return {
          error: toApiError(response.error, response.response),
        }
      }

      return {
        result: response.data as Exclude<typeof response.data, undefined>,
      }
    } catch (error) {
      return {
        error: toFetchError(error),
      }
    }
  }

  return {
    openapi: createOpenApiClient<Paths>({
      baseUrl: opts.baseUrl ?? "https://api.unprice.dev",
      cache: opts.cache ?? "no-store",
      fetch: fetchWithRetry,
      headers: headersFor(opts, sdk),
    }),
    toResult,
    settlement: { waitUntil: opts.waitUntil, onSettleError: opts.onSettleError },
    retry,
  }
}

function headersFor(opts: UnpriceOptions, sdk: SdkIdentity): Record<string, string> {
  const telemetry = opts.disableTelemetry ? null : getTelemetry(opts, sdk)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    "unprice-request-source": `${sdk.source}@${sdk.version}`,
  }
  if (telemetry?.sdkVersions) {
    headers["Unprice-Telemetry-SDK"] = telemetry.sdkVersions.join(",")
  }
  if (telemetry?.platform) {
    headers["Unprice-Telemetry-Platform"] = telemetry.platform
  }
  if (telemetry?.runtime) {
    headers["Unprice-Telemetry-Runtime"] = telemetry.runtime
  }
  return { ...headers, ...opts.headers }
}

function toFetchError(error: unknown): ApiError {
  return {
    code: "FETCH_ERROR",
    message: getErrorMessage(error),
    docs: "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
    requestId: "N/A",
  }
}

function toApiError(error: unknown, response: Response): ApiError {
  if (isErrorResponse(error)) {
    return error.error
  }

  if (isApiError(error)) {
    return error
  }

  const requestId = response.headers.get("unprice-request-id") ?? "N/A"
  const statusText = response.statusText ? ` ${response.statusText}` : ""

  return {
    code: "FETCH_ERROR",
    message: `Unexpected API response: ${response.status}${statusText}`,
    docs: "https://docs.unprice.dev/api-reference/errors",
    requestId,
  }
}
