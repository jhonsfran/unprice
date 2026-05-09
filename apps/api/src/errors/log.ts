type SerializableError = {
  message: string
  stack?: string
  type: string
}

export function serializeError(error: unknown): SerializableError {
  if (error instanceof Error) {
    const serialized: SerializableError = {
      type: error.name || "Error",
      message: error.message,
    }

    if (error.stack) {
      serialized.stack = error.stack
    }

    return serialized
  }

  return {
    type: "Error",
    message: String(error ?? "Unknown error"),
  }
}
