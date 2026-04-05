import { BaseError } from "@unprice/error"

export class UnPriceGrantError extends BaseError<{
  grantId?: string
  subjectId?: string
  subjectSource?: string
}> {
  public readonly retry = false
  public readonly name = UnPriceGrantError.name

  constructor({
    message,
    grantId,
    subjectId,
    subjectSource,
  }: {
    message: string
    grantId?: string
    subjectId?: string
    subjectSource?: string
  }) {
    super({
      message,
      context: {
        grantId,
        subjectId,
        subjectSource,
      },
    })
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
