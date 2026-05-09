import { BaseError } from "@unprice/error"

export type IngestionErrorCode = "INGESTION_AUDIT_PAYLOAD_CONFLICT"

export class UnPriceIngestionError extends BaseError<{ context?: Record<string, unknown> }> {
  public readonly retry = false
  public readonly name = UnPriceIngestionError.name
  public readonly code: IngestionErrorCode

  constructor({
    code,
    context,
    message,
  }: {
    code: IngestionErrorCode
    context?: Record<string, unknown>
    message: string
  }) {
    super({
      message,
      context,
    })
    this.code = code
  }
}
