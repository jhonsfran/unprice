export * from "./logger"
export * from "./wide-event"

// Convenience re-exports for backward compatibility
export type LogContext = Record<string, unknown>
export type LogMetadata = Record<string, unknown>
export type LogFields = Record<string, unknown>
