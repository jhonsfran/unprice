declare const __ENV: Record<string, string | undefined>
declare const __VU: number
declare const __ITER: number

declare module "k6" {
  export function check<T>(value: T, checks: Record<string, (value: T) => boolean>): boolean
  export function fail(message?: string): never
  export function sleep(seconds: number): void
}

declare module "k6/http" {
  export type Params = {
    headers?: Record<string, string>
    tags?: Record<string, string>
  }

  export type Response = {
    status: number
    body: string | null
    headers: Record<string, string>
    status_text?: string
    /** Set when no HTTP response arrived (status 0): the transport error. */
    error: string
    timings: {
      duration: number
    }
    json(): unknown
  }

  export type BatchRequest = [method: string, url: string, body: string | null, params?: Params]

  export type ResponseCallback = { readonly __brand: "ResponseCallback" }

  const http: {
    post(url: string, body: string, params?: Params): Response
    get(url: string, params?: Params): Response
    request(method: string, url: string, body?: string | null, params?: Params): Response
    batch(requests: BatchRequest[]): Response[]
    expectedStatuses(...statuses: number[]): ResponseCallback
    setResponseCallback(callback: ResponseCallback): void
  }

  export default http
}

declare module "k6/execution" {
  const exec: {
    test?: {
      abort(message?: string): never
    }
  }

  export default exec
}

declare module "k6/metrics" {
  export class Counter {
    constructor(name: string)
    add(value: number, tags?: Record<string, string>): void
  }

  export class Trend {
    constructor(name: string, isTime?: boolean)
    add(value: number): void
  }
}
