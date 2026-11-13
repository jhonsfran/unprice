import { BaseError } from "@unprice/error"

export class UnPriceGrantError extends BaseError<{
  code?: string
  grantId?: string
  subjectId?: string
  subjectSource?: string
}> {
  public readonly retry = false
  public readonly name = UnPriceGrantError.name
  public readonly code?: string

  constructor({
    message,
    code,
    grantId,
    subjectId,
    subjectSource,
  }: {
    message: string
    code?: string
    grantId?: string
    subjectId?: string
    subjectSource?: string
  }) {
    super({
      message,
      context: {
        code,
        grantId,
        subjectId,
        subjectSource,
      },
    })
    this.code = code
  }
}

export class UnPriceEntitlementError extends BaseError<{ context?: Record<string, unknown> }> {
  public readonly retry = false
  public readonly name = UnPriceEntitlementError.name

  constructor({ message, context }: { message: string; context?: Record<string, unknown> }) {
    super({
      message: `${message}`,
      context,
    })
  }
}
