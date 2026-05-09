import { BaseError } from "@unprice/error"

export class UnPriceRatingError extends BaseError<{ context?: Record<string, unknown> }> {
  public readonly retry = false
  public readonly name = UnPriceRatingError.name

  constructor({ message, context }: { message: string; context?: Record<string, unknown> }) {
    super({
      message: `${message}`,
      context,
    })
  }
}
