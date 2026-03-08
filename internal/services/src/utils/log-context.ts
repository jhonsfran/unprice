import type { WideEventInput } from "@unprice/logs"

export function toErrorContext(error: unknown): WideEventInput["error"] {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  if (error === undefined || error === null) {
    return undefined
  }

  return {
    message: String(error),
  }
}
