import createOpenApiClient, { type Client as OpenApiClient } from "openapi-fetch"
import { version } from "../package.json"
import type { ApiError, ErrorResponse } from "./errors"
import {
  type GeneratedSdkResources,
  type SdkOperationId,
  createGeneratedSdkResources,
  sdkOperations,
} from "./generated/sdk-resources"
import type { paths } from "./openapi"
import type { OperationInput, OperationResponse } from "./operation-types"
import type { ApiResult, Result } from "./result"
import type { Telemetry } from "./telemetry"
import { getTelemetry } from "./telemetry"

export type { ApiResult, Result }

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
}

type OpenApiResponse<TResult> = Promise<
  | {
      data: TResult
      error?: never
      response: Response
    }
  | {
      data?: never
      error: unknown
      response: Response
    }
>

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

export class Unprice {
  private readonly baseUrl: string
  private readonly token: string
  private readonly cache?: RequestCache
  private readonly debug: boolean
  private readonly telemetry?: Telemetry | null
  private readonly headers: Record<string, string>
  private readonly fetchImpl: (input: Request) => Promise<Response>
  private readonly openapi: OpenApiClient<paths>
  public readonly access: GeneratedSdkResources["access"]
  public readonly usage: GeneratedSdkResources["usage"]
  public readonly runs: GeneratedSdkResources["runs"]
  public readonly customers: GeneratedSdkResources["customers"]
  public readonly features: GeneratedSdkResources["features"]
  public readonly planVersions: GeneratedSdkResources["planVersions"]
  public readonly subscriptions: GeneratedSdkResources["subscriptions"]
  public readonly paymentMethods: GeneratedSdkResources["paymentMethods"]
  public readonly wallet: GeneratedSdkResources["wallet"]
  public readonly walletCredits: GeneratedSdkResources["walletCredits"]
  public readonly invoices: GeneratedSdkResources["invoices"]
  public readonly analytics: GeneratedSdkResources["analytics"]
  public readonly ingestionEvents: GeneratedSdkResources["ingestionEvents"]
  public readonly retry: {
    attempts: number
    backoff: (retryCount: number) => number
  }

  constructor(opts: UnpriceOptions) {
    this.baseUrl = opts.baseUrl ?? "https://api.unprice.dev"
    this.token = opts.token
    this.debug = opts.debug ?? false
    this.fetchImpl = opts.fetch ?? ((input) => fetch(input))

    if (!opts.disableTelemetry) {
      this.telemetry = getTelemetry(opts)
    }

    this.headers = opts.headers ?? {}
    this.cache = opts.cache ?? "default"
    /**
     * Even though TypeScript should prevent this, some people still pass undefined or empty strings.
     */
    if (!this.token) {
      throw new Error(
        "unprice root key must be set, maybe you passed in `undefined` or an empty string?"
      )
    }

    this.retry = {
      attempts: opts.retry?.attempts ?? 2,
      backoff: opts.retry?.backoff ?? ((n) => Math.round(Math.exp(n) * 10)),
    }

    this.openapi = createOpenApiClient<paths>({
      baseUrl: this.baseUrl,
      cache: this.cache,
      fetch: (request) => this.fetchWithRetry(request),
      headers: this.getHeaders(),
    })

    const resources = createGeneratedSdkResources(this.requestOperation)

    this.access = resources.access
    this.usage = resources.usage
    this.runs = resources.runs
    this.customers = resources.customers
    this.features = resources.features
    this.planVersions = resources.planVersions
    this.subscriptions = resources.subscriptions
    this.paymentMethods = resources.paymentMethods
    this.wallet = resources.wallet
    this.walletCredits = resources.walletCredits
    this.invoices = resources.invoices
    this.analytics = resources.analytics
    this.ingestionEvents = resources.ingestionEvents
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "unprice-request-source": `sdk@${version}`,
    }
    if (this.telemetry?.sdkVersions) {
      headers["Unprice-Telemetry-SDK"] = this.telemetry.sdkVersions.join(",")
    }
    if (this.telemetry?.platform) {
      headers["Unprice-Telemetry-Platform"] = this.telemetry.platform
    }
    if (this.telemetry?.runtime) {
      headers["Unprice-Telemetry-Runtime"] = this.telemetry.runtime
    }
    return { ...headers, ...this.headers }
  }

  private async fetchWithRetry(request: Request): Promise<Response> {
    let response: Response | null = null
    let err: unknown = null

    for (let attempt = 0; attempt <= this.retry.attempts; attempt++) {
      try {
        response = await this.fetchImpl(request.clone())
        err = null
      } catch (error) {
        response = null
        err = error
      }

      if (response && response.status < 500) {
        return response
      }

      if (attempt === this.retry.attempts) {
        break
      }

      const backoff = this.retry.backoff(attempt)

      if (this.debug) {
        const requestId = response?.headers.get("unprice-request-id") ?? "N/A"
        console.debug(
          `attempt ${attempt + 1} of ${this.retry.attempts + 1} to reach ${
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

  private toFetchError(error: unknown): ApiError {
    return {
      code: "FETCH_ERROR",
      message: getErrorMessage(error),
      docs: "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
      requestId: "N/A",
    }
  }

  private toApiError(error: unknown, response: Response): ApiError {
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

  private async toResult<TResult>(request: OpenApiResponse<TResult>): Promise<ApiResult<TResult>> {
    try {
      const response = await request

      if ("error" in response) {
        return {
          error: this.toApiError(response.error, response.response),
        }
      }

      return {
        result: response.data as TResult,
      }
    } catch (error) {
      return {
        error: this.toFetchError(error),
      }
    }
  }

  private splitInputForOperation(
    operation: (typeof sdkOperations)[SdkOperationId],
    input: unknown
  ): {
    path: Record<string, unknown>
    rest: Record<string, unknown>
  } {
    const source = isRecord(input) ? input : {}
    const pathParamNames = new Set<string>(operation.pathParams)
    const path: Record<string, unknown> = {}
    const rest: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(source)) {
      if (pathParamNames.has(key)) {
        path[key] = value
      } else {
        rest[key] = value
      }
    }

    return { path, rest }
  }

  private requestOperation = <TId extends SdkOperationId>(
    operationId: TId,
    input: OperationInput<TId> | undefined
  ): Promise<ApiResult<OperationResponse<TId>>> => {
    const operation = sdkOperations[operationId]
    const method: string = operation.method
    const { path, rest } = this.splitInputForOperation(operation, input)
    const pathParams = Object.keys(path).length > 0 ? path : undefined
    const restParams = Object.keys(rest).length > 0 ? rest : undefined

    if (method === "GET") {
      return this.toResult(
        this.openapi.GET(
          operation.path as never,
          {
            params: {
              ...(pathParams ? { path: pathParams } : {}),
              ...(restParams ? { query: restParams } : {}),
            },
          } as never
        ) as never
      )
    }

    if (method === "POST") {
      return this.toResult(
        this.openapi.POST(
          operation.path as never,
          {
            params: pathParams
              ? {
                  path: pathParams,
                }
              : undefined,
            body: restParams,
          } as never
        ) as never
      )
    }

    return this.toResult(
      Promise.resolve({
        error: {
          error: {
            code: "FETCH_ERROR",
            message: `Unsupported SDK operation method ${method}`,
            docs: "https://docs.unprice.dev/api-reference/errors",
            requestId: "N/A",
          },
        },
        response: new Response(null, { status: 500 }),
      })
    )
  }
}
