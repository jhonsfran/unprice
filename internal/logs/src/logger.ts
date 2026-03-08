import type { WideEventInput } from "./wide-event"

export type LogContext = WideEventInput & Record<string, unknown>
export type LogMetadata = Record<string, unknown>
export type LogFields = LogContext

export interface Logger {
  set(fields: LogContext): void
  debug(message: string, fields?: LogMetadata): void
  info(message: string, fields?: LogMetadata): void
  warn(message: string, fields?: LogMetadata): void
  error(message: unknown, fields?: LogMetadata): void
  flush(): Promise<void>
}
