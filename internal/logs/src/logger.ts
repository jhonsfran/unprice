/**
 * Logger interface used by all domain services.
 *
 * Implementations live in @unprice/observability; services depend
 * only on this type contract.
 */
export interface Logger {
  set(fields: Record<string, unknown>): void
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: unknown, fields?: Record<string, unknown>): void
  flush(): Promise<void>
}
