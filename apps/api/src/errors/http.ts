import { z } from "@hono/zod-openapi"
import { FetchError } from "@unprice/error"
import { type DomainErrorKind, resolveDomainErrorKind } from "@unprice/services"
import { UnPriceBudgetError } from "@unprice/services/budgets"
import { UnPriceWalletError } from "@unprice/services/wallet"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import type { StatusCode } from "hono/utils/http-status"
import type { ZodError } from "zod"
import type { HonoEnv } from "~/hono/env"
import { parseZodErrorMessage } from "~/util/zod-error"
import { ErrorCode, UnpriceApiError, apiErrorDetailsSchema } from "./api-error"
export { UnpriceApiError, apiErrorDetailsSchema } from "./api-error"
export type { ApiErrorDetails } from "./api-error"
import { budgetRejectionError } from "./budget"

export function errorSchemaFactory<T extends Record<string, string>>(code: z.ZodEnum<T>) {
  return z.object({
    error: z.object({
      code: code.openapi({
        description: "A machine readable error code.",
        example: code.options.at(0),
      }),
      docs: z.string().openapi({
        description: "A link to our documentation with more details about this error code",
        example: `https://docs.unprice.dev/api-reference/errors/code/${code.options.at(0)}`,
      }),
      message: z
        .string()
        .openapi({ description: "A human readable explanation of what went wrong" }),
      requestId: z.string().openapi({
        description: "Please always include the requestId in your error report",
        example: "req_1234",
      }),
      details: apiErrorDetailsSchema.optional(),
    }),
  })
}

export const ErrorSchema = z.object({
  error: z.object({
    code: ErrorCode.openapi({
      description: "A machine readable error code.",
      example: "INTERNAL_SERVER_ERROR",
    }),
    docs: z.string().openapi({
      description: "A link to our documentation with more details about this error code",
      example: "https://docs.unprice.dev/api-reference/errors/code/BAD_REQUEST",
    }),
    message: z.string().openapi({ description: "A human readable explanation of what went wrong" }),
    requestId: z.string().openapi({
      description: "Please always include the requestId in your error report",
      example: "req_1234",
    }),
    details: apiErrorDetailsSchema.optional(),
  }),
})

export type ErrorResponse = z.infer<typeof ErrorSchema>

type PublicErrorCode = z.infer<typeof ErrorCode>

const domainErrorCode: Record<DomainErrorKind, PublicErrorCode> = {
  bad_request: "BAD_REQUEST",
  forbidden: "FORBIDDEN",
  precondition: "PRECONDITION_FAILED",
  conflict: "CONFLICT",
  not_found: "NOT_FOUND",
  internal: "INTERNAL_SERVER_ERROR",
}

const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error"

function clientErrorMessage(status: StatusCode, message: string): string {
  return status >= 500 ? INTERNAL_SERVER_ERROR_MESSAGE : message
}

function statusToCode(status: StatusCode): z.infer<typeof ErrorCode> {
  switch (status) {
    case 400:
      return "BAD_REQUEST"
    case 401:
      return "UNAUTHORIZED"
    case 402:
      return "BUDGET_EXCEEDED"
    case 403:
      return "FORBIDDEN"

    case 404:
      return "NOT_FOUND"

    case 405:
      return "METHOD_NOT_ALLOWED"
    case 413:
      return "PAYLOAD_TOO_LARGE"
    case 500:
      return "INTERNAL_SERVER_ERROR"
    default:
      return "INTERNAL_SERVER_ERROR"
  }
}

/**
 * Route adapters should normalize expected domain/infrastructure failures to UnpriceApiError.
 * Unexpected errors can still surface as INTERNAL_SERVER_ERROR.
 */
export function toUnpriceApiError(error: unknown): UnpriceApiError {
  if (error instanceof UnpriceApiError) {
    return error
  }

  if (error instanceof FetchError) {
    return new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message: error.message,
    })
  }

  if (error instanceof UnPriceWalletError && error.message === "WALLET_LEDGER_FAILED") {
    return new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message: error.message,
    })
  }

  if (error instanceof UnPriceBudgetError) return budgetRejectionError(error)

  const domainKind = resolveDomainErrorKind(error)

  if (domainKind && error instanceof Error) {
    return new UnpriceApiError({
      code: domainErrorCode[domainKind],
      message: error.message,
    })
  }

  if (error instanceof HTTPException) {
    return new UnpriceApiError({
      code: statusToCode(error.status),
      message: error.message,
    })
  }

  if (error instanceof Error) {
    return new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message: error.message,
    })
  }

  return new UnpriceApiError({
    code: "INTERNAL_SERVER_ERROR",
    message: "something unexpected happened",
  })
}

export function handleZodError(
  result:
    | {
        success: true
        data: unknown
      }
    | {
        success: false
        error: ZodError
      },
  c: Context
) {
  if (!result.success) {
    return c.json<z.infer<typeof ErrorSchema>>(
      {
        error: {
          code: "BAD_REQUEST",
          docs: "https://docs.unprice.dev/api-reference/errors/code/BAD_REQUEST",
          message: parseZodErrorMessage(result.error),
          requestId: c.get("requestId"),
        },
      },
      { status: 400 }
    )
  }
}

export function handleError(err: Error, c: Context<HonoEnv>): Response {
  /**
   * We can handle this very well, as it is something we threw ourselves
   */
  if (err instanceof UnpriceApiError) {
    if (err.status >= 500) {
      console.error("returning 5XX", {
        message: err.message,
        name: err.name,
        code: err.code,
        status: err.status,
      })
    }
    return c.json<z.infer<typeof ErrorSchema>>(
      {
        error: {
          code: err.code,
          docs: `https://docs.unprice.dev/api-reference/errors/code/${err.code}`,
          message: clientErrorMessage(err.status, err.message),
          requestId: c.get("requestId"),
          // a 5XX message is replaced with a generic one, so its detail goes with it
          ...(err.details && err.status < 500 ? { details: err.details } : {}),
        },
      },
      { status: err.status }
    )
  }

  /**
   * HTTPExceptions from hono at least give us some idea of what to do as they provide a status and
   * message
   */
  if (err instanceof HTTPException) {
    if (err.status >= 500) {
      console.error("HTTPException", {
        message: err.message,
        status: err.status,
        requestId: c.get("requestId"),
      })
    }
    const code = statusToCode(err.status)
    return c.json<z.infer<typeof ErrorSchema>>(
      {
        error: {
          code,
          docs: `https://docs.unprice.dev/api-reference/errors/code/${code}`,
          message: clientErrorMessage(err.status, err.message),
          requestId: c.get("requestId"),
        },
      },
      { status: err.status }
    )
  }

  return handleError(toUnpriceApiError(err), c)
}
