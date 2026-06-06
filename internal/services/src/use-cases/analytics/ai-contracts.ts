import { z } from "zod"

export const aiEvidenceSchema = z.object({
  type: z.enum([
    "event",
    "meter_fact",
    "ingestion_status",
    "ledger_line",
    "billing_period",
    "invoice",
    "plan_version",
  ]),
  id: z.string(),
  source: z.enum(["tinybird", "r2", "ledger", "postgres"]),
  timestamp: z.number().int().nullable(),
})

export const aiAnswerEnvelopeSchema = z.object({
  answer: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  freshness: z.object({
    generatedAt: z.number().int(),
    dataFrom: z.number().int().nullable(),
    dataTo: z.number().int().nullable(),
  }),
  evidence: z.array(aiEvidenceSchema),
  warnings: z.array(z.string()),
  nextActions: z.array(z.string()),
})

export type AiEvidence = z.infer<typeof aiEvidenceSchema>
export type AiAnswerEnvelope = z.infer<typeof aiAnswerEnvelopeSchema>
