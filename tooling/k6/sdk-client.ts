import http from "k6/http"
import { type ApiResult, Unprice } from "../../packages/api/src/index"

type K6HeaderInit =
  | K6Headers
  | Record<string, string | string[] | number | boolean>
  | Iterable<[string, string]>

type K6RequestInit = {
  method?: string
  headers?: K6HeaderInit
  body?: string | null
}

type K6HttpResponse = {
  body: string | null
  headers: Record<string, string>
  status: number
  status_text?: string
}

type K6FetchGlobals = {
  Headers?: unknown
  Request?: unknown
  Response?: unknown
  FormData?: unknown
}

type ResultWithError = {
  error?: {
    code?: string
    message?: string
    requestId?: string
  }
}

export type K6SdkClient = Unprice

class K6Headers {
  private readonly values = new Map<string, string>()

  constructor(init: K6HeaderInit = {}) {
    if (init instanceof K6Headers) {
      for (const [key, value] of init.entries()) {
        this.set(key, value)
      }
      return
    }

    if (isIterableHeaders(init)) {
      for (const [key, value] of init) {
        this.set(key, value)
      }
      return
    }

    for (const [key, value] of Object.entries(init)) {
      this.set(key, Array.isArray(value) ? value.join(",") : String(value))
    }
  }

  append(key: string, value: string): void {
    const normalizedKey = key.toLowerCase()
    const currentValue = this.values.get(normalizedKey)
    this.values.set(normalizedKey, currentValue ? `${currentValue}, ${value}` : String(value))
  }

  delete(key: string): void {
    this.values.delete(key.toLowerCase())
  }

  entries(): IterableIterator<[string, string]> {
    return this.values.entries()
  }

  get(key: string): string | null {
    return this.values.get(key.toLowerCase()) ?? null
  }

  set(key: string, value: string): void {
    this.values.set(key.toLowerCase(), String(value))
  }
}

class K6Request {
  readonly url: string
  readonly method: string
  readonly headers: K6Headers
  readonly body?: string | null

  constructor(input: string | K6Request, init: K6RequestInit = {}) {
    const source = typeof input === "string" ? null : input

    this.url = typeof input === "string" ? input : input.url
    this.method = init.method ?? source?.method ?? "GET"
    this.headers = new K6Headers(init.headers ?? source?.headers ?? {})
    this.body = init.body ?? source?.body
  }

  clone(): K6Request {
    return new K6Request(this.url, {
      body: this.body,
      headers: this.headers,
      method: this.method,
    })
  }
}

class K6Response {
  readonly body: string | null
  readonly headers: K6Headers
  readonly ok: boolean
  readonly status: number
  readonly statusText: string

  constructor(response: K6HttpResponse) {
    this.body = response.body
    this.headers = new K6Headers(response.headers)
    this.ok = response.status >= 200 && response.status <= 299
    this.status = response.status
    this.statusText = response.status_text ?? String(response.status)
  }

  async json(): Promise<unknown> {
    return this.body ? JSON.parse(this.body) : null
  }

  async text(): Promise<string> {
    return this.body ?? ""
  }
}

export function createK6SdkClient(input: {
  baseUrl: string
  token: string
  headers?: Record<string, string>
}): K6SdkClient {
  installK6FetchGlobals()

  return new Unprice({
    baseUrl: input.baseUrl,
    disableTelemetry: true,
    fetch: k6Fetch as unknown as (input: Request) => Promise<Response>,
    headers: input.headers,
    retry: {
      attempts: 0,
    },
    token: input.token,
  })
}

export function describeSdkError(result: ResultWithError): string {
  if (!result.error) {
    return "unknown SDK error"
  }

  return `${result.error.code ?? "UNKNOWN"}: ${result.error.message ?? "No message"} (${result.error.requestId ?? "N/A"})`
}

export function isRateLimited(result: ResultWithError): boolean {
  return result.error?.code === "RATE_LIMITED"
}

export function isSuccessfulResult<T>(result: ApiResult<T>): result is { result: T } {
  return !result.error && result.result !== undefined
}

function installK6FetchGlobals(): void {
  const globals = globalThis as unknown as K6FetchGlobals

  if (!globals.Headers) {
    globals.Headers = K6Headers
  }

  if (!globals.Request) {
    globals.Request = K6Request
  }

  if (!globals.Response) {
    globals.Response = K6Response
  }

  if (!globals.FormData) {
    globals.FormData = class FormData {}
  }
}

function k6Fetch(request: K6Request): Promise<K6Response> {
  const requestPath = getPathFromRequestUrl(request.url)
  const response = http.request(request.method, request.url, request.body ?? null, {
    headers: Object.fromEntries(request.headers.entries()),
    tags: {
      name: `${request.method} ${requestPath}`,
    },
  }) as K6HttpResponse

  return Promise.resolve(new K6Response(response))
}

function getPathFromRequestUrl(url: string): string {
  const protocolIndex = url.indexOf("://")

  if (protocolIndex === -1) {
    return url
  }

  const pathStart = url.indexOf("/", protocolIndex + 3)

  if (pathStart === -1) {
    return "/"
  }

  const queryStart = url.indexOf("?", pathStart)
  return queryStart === -1 ? url.slice(pathStart) : url.slice(pathStart, queryStart)
}

function isIterableHeaders(value: K6HeaderInit): value is Iterable<[string, string]> {
  return typeof (value as Iterable<[string, string]>)[Symbol.iterator] === "function"
}
