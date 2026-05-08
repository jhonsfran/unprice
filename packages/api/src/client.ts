import createOpenApiClient, { type Client as OpenApiClient } from "openapi-fetch"
import { version } from "../package.json"
import type { ApiError, ErrorResponse } from "./errors"
import type { paths } from "./openapi"
import type { Telemetry } from "./telemetry"
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

type JsonContent<TResponse> = TResponse extends {
  content: {
    "application/json": infer TContent
  }
}
  ? TContent
  : never

type JsonRequestBody<TOperation> = TOperation extends {
  requestBody: {
    content: {
      "application/json": infer TBody
    }
  }
}
  ? TBody
  : never

type JsonResponse<TOperation, TStatus extends number> = TOperation extends {
  responses: infer TResponses
}
  ? TStatus extends keyof TResponses
    ? JsonContent<TResponses[TStatus]>
    : never
  : never

type PostBody<TPath extends keyof paths> = paths[TPath] extends { post: infer TOperation }
  ? JsonRequestBody<TOperation>
  : never

type PostResponse<TPath extends keyof paths, TStatus extends number = 200> = paths[TPath] extends {
  post: infer TOperation
}
  ? JsonResponse<TOperation, TStatus>
  : never

type GetResponse<TPath extends keyof paths, TStatus extends number = 200> = paths[TPath] extends {
  get: infer TOperation
}
  ? JsonResponse<TOperation, TStatus>
  : never

type GetQuery<TPath extends keyof paths> = paths[TPath] extends {
  get: {
    parameters: {
      query: infer TQuery
    }
  }
}
  ? TQuery
  : never

type GetPath<TPath extends keyof paths> = paths[TPath] extends {
  get: {
    parameters: {
      path: infer TPathParams
    }
  }
}
  ? TPathParams
  : never

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

export type ApiResult<TResult> =
  | {
      result: TResult
      error?: never
    }
  | {
      result?: never
      error: ApiError
    }

export type Result<TResult> = ApiResult<TResult>

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

  public get access() {
    return {
      update: (
        req: PostBody<"/v1/access/update">
      ): Promise<ApiResult<PostResponse<"/v1/access/update">>> => {
        return this.toResult(
          this.openapi.POST("/v1/access/update", {
            body: req,
          })
        )
      },
    }
  }

  public get customers() {
    return {
      signUp: (
        req: PostBody<"/v1/customers/sign-up">
      ): Promise<ApiResult<PostResponse<"/v1/customers/sign-up">>> => {
        return this.toResult(
          this.openapi.POST("/v1/customers/sign-up", {
            body: req,
          })
        )
      },
    }
  }

  public get entitlements() {
    return {
      get: (
        req: PostBody<"/v1/entitlements/get">
      ): Promise<ApiResult<PostResponse<"/v1/entitlements/get">>> => {
        return this.toResult(
          this.openapi.POST("/v1/entitlements/get", {
            body: req,
          })
        )
      },

      verify: (
        req: PostBody<"/v1/entitlements/verify">
      ): Promise<ApiResult<PostResponse<"/v1/entitlements/verify">>> => {
        return this.toResult(
          this.openapi.POST("/v1/entitlements/verify", {
            body: req,
          })
        )
      },
    }
  }

  public get events() {
    return {
      ingest: (
        req: PostBody<"/v1/events/ingest">
      ): Promise<ApiResult<PostResponse<"/v1/events/ingest", 202>>> => {
        return this.toResult(
          this.openapi.POST("/v1/events/ingest", {
            body: req,
          })
        )
      },

      ingestSync: (
        req: PostBody<"/v1/events/ingest/sync">
      ): Promise<ApiResult<PostResponse<"/v1/events/ingest/sync">>> => {
        return this.toResult(
          this.openapi.POST("/v1/events/ingest/sync", {
            body: req,
          })
        )
      },
    }
  }

  public get features() {
    return {
      list: (): Promise<ApiResult<GetResponse<"/v1/features/list">>> => {
        return this.toResult(this.openapi.GET("/v1/features/list"))
      },
    }
  }

  public get lakehouse() {
    return {
      getFilePlan: (
        req: PostBody<"/v1/lakehouse/file-plan">
      ): Promise<ApiResult<PostResponse<"/v1/lakehouse/file-plan">>> => {
        return this.toResult(
          this.openapi.POST("/v1/lakehouse/file-plan", {
            body: req,
          })
        )
      },
    }
  }

  public get plans() {
    const getVersion = (
      req: GetPath<"/v1/plans/versions/get/{planVersionId}">
    ): Promise<ApiResult<GetResponse<"/v1/plans/versions/get/{planVersionId}">>> => {
      return this.toResult(
        this.openapi.GET("/v1/plans/versions/get/{planVersionId}", {
          params: {
            path: req,
          },
        })
      )
    }

    return {
      listVersions: (
        req: PostBody<"/v1/plans/versions/list">
      ): Promise<ApiResult<PostResponse<"/v1/plans/versions/list">>> => {
        return this.toResult(
          this.openapi.POST("/v1/plans/versions/list", {
            body: req,
          })
        )
      },
      getVersion,
    }
  }

  public get payments() {
    return {
      methods: {
        list: (
          req: PostBody<"/v1/payments/methods/list">
        ): Promise<ApiResult<PostResponse<"/v1/payments/methods/list">>> => {
          return this.toResult(
            this.openapi.POST("/v1/payments/methods/list", {
              body: req,
            })
          )
        },

        create: (
          req: PostBody<"/v1/payments/methods/create">
        ): Promise<ApiResult<PostResponse<"/v1/payments/methods/create">>> => {
          return this.toResult(
            this.openapi.POST("/v1/payments/methods/create", {
              body: req,
            })
          )
        },
      },
    }
  }

  public get subscriptions() {
    return {
      get: (
        req: PostBody<"/v1/subscriptions/get">
      ): Promise<ApiResult<PostResponse<"/v1/subscriptions/get">>> => {
        return this.toResult(
          this.openapi.POST("/v1/subscriptions/get", {
            body: req,
          })
        )
      },
    }
  }

  public get usage() {
    return {
      get: (req: PostBody<"/v1/usage/get">): Promise<ApiResult<PostResponse<"/v1/usage/get">>> => {
        return this.toResult(
          this.openapi.POST("/v1/usage/get", {
            body: req,
          })
        )
      },
    }
  }

  public get realtime() {
    return {
      createTicket: (
        req: PostBody<"/v1/realtime/tickets/create">
      ): Promise<ApiResult<PostResponse<"/v1/realtime/tickets/create">>> => {
        return this.toResult(
          this.openapi.POST("/v1/realtime/tickets/create", {
            body: req,
          })
        )
      },
    }
  }

  public get wallet() {
    return {
      get: (req: GetQuery<"/v1/wallet">): Promise<ApiResult<GetResponse<"/v1/wallet">>> => {
        return this.toResult(
          this.openapi.GET("/v1/wallet", {
            params: {
              query: req,
            },
          })
        )
      },
    }
  }

  public get invoices() {
    return {
      get: (
        req: GetPath<"/v1/invoices/{invoiceId}">
      ): Promise<ApiResult<GetResponse<"/v1/invoices/{invoiceId}">>> => {
        return this.toResult(
          this.openapi.GET("/v1/invoices/{invoiceId}", {
            params: {
              path: req,
            },
          })
        )
      },
    }
  }
}
