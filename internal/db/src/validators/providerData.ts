import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import * as schema from "../schema"
import { paymentProviderSchema } from "./shared"

export const customerProviderMetadataSchema = z.record(z.string(), z.unknown())

export const customerProviderIdSelectSchema = createSelectSchema(schema.customerProviderIds, {
  provider: paymentProviderSchema,
  providerCustomerId: z.string().min(1),
  metadata: customerProviderMetadataSchema.nullable().optional(),
})

export const customerProviderIdInsertSchema = createInsertSchema(schema.customerProviderIds, {
  provider: paymentProviderSchema,
  providerCustomerId: z.string().min(1),
  metadata: customerProviderMetadataSchema.nullable().optional(),
})
  .omit({
    createdAtM: true,
    updatedAtM: true,
  })
  .partial({
    id: true,
    projectId: true,
    metadata: true,
  })
  .required({
    customerId: true,
    provider: true,
    providerCustomerId: true,
  })

export const webhookEventStatusSchema = z.enum(["pending", "processing", "processed", "failed"])

export const webhookEventHeadersSchema = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string())])
)

export const webhookEventErrorSchema = z
  .object({
    code: z.string().optional(),
    message: z.string().optional(),
    details: z.unknown().optional(),
  })
  .passthrough()

export const webhookEventSelectSchema = createSelectSchema(schema.webhookEvents, {
  provider: paymentProviderSchema,
  providerEventId: z.string().min(1),
  rawPayload: z.string().min(1),
  status: webhookEventStatusSchema,
  headers: webhookEventHeadersSchema.nullable().optional(),
  errorPayload: webhookEventErrorSchema.nullable().optional(),
})

export const webhookEventInsertSchema = createInsertSchema(schema.webhookEvents, {
  provider: paymentProviderSchema,
  providerEventId: z.string().min(1),
  rawPayload: z.string().min(1),
  status: webhookEventStatusSchema.default("pending"),
  headers: webhookEventHeadersSchema.nullable().optional(),
  errorPayload: webhookEventErrorSchema.nullable().optional(),
})
  .omit({
    createdAtM: true,
    updatedAtM: true,
  })
  .partial({
    id: true,
    projectId: true,
    processedAtM: true,
    attempts: true,
    signature: true,
    headers: true,
    errorPayload: true,
  })
  .required({
    provider: true,
    providerEventId: true,
    rawPayload: true,
  })

export type CustomerProviderId = z.infer<typeof customerProviderIdSelectSchema>
export type InsertCustomerProviderId = z.infer<typeof customerProviderIdInsertSchema>
export type WebhookEvent = z.infer<typeof webhookEventSelectSchema>
export type InsertWebhookEvent = z.infer<typeof webhookEventInsertSchema>
