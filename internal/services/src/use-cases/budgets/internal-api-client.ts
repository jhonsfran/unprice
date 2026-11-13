import { Err, FetchError, Ok, type Result } from "@unprice/error"
import { z } from "zod"
import type { UnPriceBudgetError } from "../../budgets"

type GatewayFetch = (request: Request) => Promise<Response>
export type InternalApiOptions = {
  baseUrl?: string
  token: string
  fetch?: GatewayFetch
  timeoutMs?: number
}

export class InternalApiClient {
  private readonly baseUrl: string
  private readonly fetch: GatewayFetch
  constructor(private readonly options: InternalApiOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.unprice.dev").replace(/\/+$/, "")
    this.fetch = options.fetch ?? fetch
  }
  async post<T>(
    path: string,
    input: unknown,
    schema: z.ZodType<T>,
    opts: {
      rejectionOf?: (status: number, body: unknown) => UnPriceBudgetError | null
      timeoutMs?: number
    } = {}
  ): Promise<Result<T, FetchError | UnPriceBudgetError>> {
    const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs
    const context = { url: path, method: "POST" }
    const controller = new AbortController()
    const timer =
      timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    let body: unknown
    try {
      response = await this.fetch(
        new Request(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        })
      )
      body = await response.json().catch(() => null)
    } catch (error) {
      const message = controller.signal.aborted
        ? `${path} timed out after ${timeoutMs} ms`
        : error instanceof Error
          ? error.message
          : `${path} failed`
      return Err(new FetchError({ message, retry: true, context }))
    } finally {
      clearTimeout(timer)
    }
    const rejection = opts.rejectionOf?.(response.status, body)
    if (rejection) return Err(rejection)
    if (!response.ok) {
      return Err(
        new FetchError({
          message: errorOf(body)?.message ?? `${path} failed with status ${response.status}`,
          retry: response.status >= 500,
          context: { ...context, status: response.status },
        })
      )
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      return Err(
        new FetchError({
          message: `${path} answered an unexpected body: ${parsed.error.message}`,
          retry: false,
          context: { ...context, status: response.status },
        })
      )
    }
    return Ok(parsed.data)
  }
}

export function errorOf(body: unknown) {
  const parsed = z
    .object({
      error: z.object({
        code: z.string().optional(),
        message: z.string().optional(),
        details: z.unknown().optional(),
      }),
    })
    .safeParse(body)
  return parsed.success ? parsed.data.error : null
}
