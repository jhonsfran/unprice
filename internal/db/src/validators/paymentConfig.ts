import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import { paymentProviderConfig } from "../schema/paymentConfig"
import { paymentProviderSchema } from "./shared"

export const paymentProviderConnectionTypeSchema = z.enum([
  "managed_connection",
  "bring_your_own_key",
])
export const paymentProviderConnectionModeSchema = z.enum(["test", "live"])
export const paymentProviderConnectionStatusSchema = z.enum([
  "not_connected",
  "pending",
  "active",
  "restricted",
  "disabled",
])

const stripeRequirementFieldsSchema = z.array(z.string()).nullable().optional()

export const stripeAccountRequirementErrorSchema = z
  .object({
    code: z.string().optional(),
    reason: z.string().optional(),
    requirement: z.string().optional(),
  })
  .catchall(z.unknown())

export const stripeAccountRequirementAlternativeSchema = z
  .object({
    alternative_fields_due: stripeRequirementFieldsSchema,
    original_fields_due: stripeRequirementFieldsSchema,
  })
  .catchall(z.unknown())

export const stripeAccountRequirementsSchema = z
  .object({
    alternatives: z.array(stripeAccountRequirementAlternativeSchema).nullable().optional(),
    current_deadline: z.number().nullable().optional(),
    currently_due: stripeRequirementFieldsSchema,
    disabled_reason: z.string().nullable().optional(),
    errors: z.array(stripeAccountRequirementErrorSchema).nullable().optional(),
    eventually_due: stripeRequirementFieldsSchema,
    past_due: stripeRequirementFieldsSchema,
    pending_verification: stripeRequirementFieldsSchema,
  })
  .catchall(z.unknown())

export const paymentProviderConnectionDataSchema = z
  .object({
    chargesEnabled: z.boolean().optional(),
    payoutsEnabled: z.boolean().optional(),
    detailsSubmitted: z.boolean().optional(),
    requirements: stripeAccountRequirementsSchema.nullable().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    disabledReason: z.string().nullable().optional(),
    dashboardUrl: z.string().url().optional(),
  })
  .catchall(z.unknown())
  .nullable()

export const insertPaymentProviderConfigSchema = createInsertSchema(paymentProviderConfig, {
  key: z.string().min(1).optional().nullable(),
  keyIv: z.string().optional().nullable(),
  webhookSecret: z.string().optional(),
  paymentProvider: paymentProviderSchema,
  connectionType: paymentProviderConnectionTypeSchema.default("bring_your_own_key"),
  mode: paymentProviderConnectionModeSchema.default("test"),
  status: paymentProviderConnectionStatusSchema.default("not_connected"),
  externalAccountId: z.string().optional().nullable(),
  connectionData: paymentProviderConnectionDataSchema.optional(),
})
  .required({
    paymentProvider: true,
    active: true,
  })
  .extend({
    projectSlug: z.string().optional(),
  })
  .partial({
    projectId: true,
    createdAtM: true,
    updatedAtM: true,
    id: true,
  })

export const selectPaymentProviderConfigSchema = createSelectSchema(paymentProviderConfig, {
  connectionType: paymentProviderConnectionTypeSchema,
  mode: paymentProviderConnectionModeSchema,
  status: paymentProviderConnectionStatusSchema,
  connectionData: paymentProviderConnectionDataSchema.optional(),
})

export type InsertPaymentProviderConfig = z.infer<typeof insertPaymentProviderConfigSchema>
export type PaymentProviderConfig = z.infer<typeof selectPaymentProviderConfigSchema>
