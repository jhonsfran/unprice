import { BaseError } from "@unprice/error"

export class UnPriceLedgerError extends BaseError<{ context?: Record<string, unknown> }> {
  public readonly retry = false
  public readonly name = UnPriceLedgerError.name

  constructor({ message, context }: { message: string; context?: Record<string, unknown> }) {
    super({
      message: `${message}`,
      context,
    })
  }
}
