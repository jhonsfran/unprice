import { metricSchema } from "@unprice/metrics"
import { z } from "zod"
export * from "./wide-event"

export const logSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("log"),
    level: z.enum(["debug", "info", "warn", "error", "fatal"]),
    requestId: z.string(),
    time: z.number(),
    message: z.string(),
    context: z.record(z.any()).optional(),
    environment: z.enum(["development", "test", "production", "preview"]).default("development"),
    service: z.string(),
    colo: z.string().optional(),
    durableObjectId: z.string().optional(),
  }),
  z.object({
    type: z.literal("metric"),
    requestId: z.string(),
    time: z.number(),
    metric: metricSchema,
    environment: z.enum(["development", "test", "production", "preview"]).default("development"),
    service: z.string(),
    colo: z.string().optional(),
    durableObjectId: z.string().optional(),
  }),
])

export type LogSchema = z.infer<typeof logSchema>

export class Log<TLog extends LogSchema = LogSchema> {
  public readonly log: TLog

  constructor(log: TLog) {
    this.log = log
  }

  public toString(): string {
    return JSON.stringify({ ...this.log, time: Date.now() }, null, 2)
  }
}
