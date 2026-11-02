import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import { domains } from "../schema"

export const domainSelectBaseSchema = createSelectSchema(domains)
export const domainCreateBaseSchema = createInsertSchema(domains, {
  // validate name as a domain or subdomain
  name: () =>
    z
      .string()
      .min(3)
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Invalid domain name"),
  apexName: () =>
    z
      .string()
      .min(3)
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Invalid domain name"),
}).partial({
  id: true,
  workspaceId: true,
  createdAtM: true,
  updatedAtM: true,
  apexName: true,
})

export const domainUpdateBaseSchema = domainCreateBaseSchema.required({
  id: true,
  name: true,
})

export const domainConfigResponseSchema = z
  .object({
    configuredBy: z
      .union([z.literal("CNAME"), z.literal("A"), z.literal("http")])
      .optional()
      .nullable(),
    acceptedChallenges: z
      .array(z.union([z.literal("dns-01"), z.literal("http-01")]))
      .optional()
      .nullable(),
    misconfigured: z.boolean(),
  })
  .extend({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .optional(),
  })

export const domainResponseSchema = z
  .object({
    name: z.string().optional(),
    apexName: z.string().optional(),
    projectId: z.string().optional(),
    redirect: z.string().optional().nullable(),
    redirectStatusCode: z
      .union([z.literal(307), z.literal(301), z.literal(302), z.literal(308)])
      .optional()
      .nullable(),
    gitBranch: z.string().optional().nullable(),
    updatedAtM: z.number().optional(),
    createdAtM: z.number().optional(),
    verified: z.boolean().optional(),
    configVerifiedAt: z.number().optional().nullable(),
    verification: z
      .array(
        z.object({
          type: z.string(),
          domain: z.string(),
          value: z.string(),
          reason: z.string(),
        })
      )
      .optional(),
  })
  .extend({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .optional(),
  })

export const domainVerificationStatusSchema = z.union([
  z.literal("Valid Configuration"),
  z.literal("Invalid Configuration"),
  z.literal("Pending Verification"),
  z.literal("Domain Not Found"),
  z.literal("Unknown Error"),
])

export type DomainVerificationResponse = z.infer<typeof domainResponseSchema>
export type DomainConfigResponse = z.infer<typeof domainConfigResponseSchema>
export type DomainResponse = z.infer<typeof domainResponseSchema>
export type DomainVerificationStatusProps = z.infer<typeof domainVerificationStatusSchema>
export type Domain = z.infer<typeof domainSelectBaseSchema>
export type CreateDomain = z.infer<typeof domainCreateBaseSchema>
