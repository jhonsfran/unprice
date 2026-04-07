import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { extendZodWithOpenApi } from "zod-openapi"
import * as schema from "../schema"
import { billingIntervalSchema, currencySchema, paymentProviderSchema } from "./shared"
import { subscriptionItemsConfigSchema } from "./subscriptions/items"

extendZodWithOpenApi(z)

export const customerMetadataSchema = z.object({
  // analytics
  country: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
})

export const customerSelectSchema = createSelectSchema(schema.customers, {
  metadata: customerMetadataSchema,
  timezone: z.string().min(1),
  active: z.boolean(),
})

export const customerInsertBaseSchema = createInsertSchema(schema.customers, {
  metadata: customerMetadataSchema,
  email: z.string().min(3).email(),
  name: z.string().min(3),
  timezone: z.string().min(1),
  active: z.boolean().default(true),
})
  .omit({
    createdAtM: true,
    updatedAtM: true,
  })
  .partial({
    id: true,
    projectId: true,
  })

export const customerSignUpSchema = z
  .object({
    name: z.string().min(1, "Name is required").openapi({
      description: "The name of the customer",
      example: "John Doe",
    }),
    timezone: z.string().optional().openapi({
      description:
        "The timezone of the customer, if passed null the system will use the project timezone",
      example: "UTC",
    }),
    defaultCurrency: currencySchema.optional().openapi({
      description:
        "The default currency of the customer, if passed null the system will use the project currency",
      example: "USD",
    }),
    email: z.string().email("Invalid email").min(1, "Email is required").openapi({
      description: "The email of the customer",
      example: "test@example.com",
    }),
    billingInterval: billingIntervalSchema.optional().openapi({
      description:
        "The billing interval of the customer to be used for the subscription. If plan version is provided, the billing interval will be the same as the plan version. If plan slug is provided, the billing interval will be the default billing interval of the plan.",
      example: "month",
    }),
    // either plan slug or plan version id is required
    planSlug: z.string().optional().openapi({
      description:
        "If the plan id is not provided, you can pass a plan slug and the system will intelligently pick the lastest plan for that slug and sign up the customer for it",
      example: "PRO",
    }),
    sessionId: z.string().optional().openapi({
      description:
        "The session id of the customer. This is used to track conversion from pricing pages",
      example: "sess_1234567890",
    }),
    planVersionId: z.string().optional().openapi({
      description: "The plan version the customer is signing up for",
      example: "pv_1234567890",
    }),
    config: subscriptionItemsConfigSchema.optional().openapi({
      description:
        "The configuration of the subscription items. This is required if your features are quantity based when the customer needs to set them. Pass as empty if you want the system to automatically set the units from the plan defaults.",
      example: [
        {
          featurePlanId: "feature_plan_123",
          featureSlug: "feature_slug_123",
          isUsage: true,
          units: 100,
        },
      ],
    }),
    externalId: z.string().optional().openapi({
      description:
        "The external id you want to associate with the customer. Could be the id of the user in your database",
      example: "1234567890",
    }),
    successUrl: z.string().url().openapi({
      description:
        "The success url if the customer signs up. This is the url after the signup process, normally your dashboard",
      example: "https://example.com/dashboard",
    }),
    cancelUrl: z.string().url().openapi({
      description:
        "The cancel url if the customer cancels the signup. This is the url after the signup process, normally your login page",
      example: "https://example.com/login",
    }),
    metadata: customerMetadataSchema.optional().openapi({
      description:
        "The metadata of the customer, very important to pass geolocation data if you want to segment later on",
      example: {
        country: "US",
        region: "CA",
        city: "San Francisco",
      },
    }),
  })
  .superRefine((data, ctx) => {
    if (!data.planSlug && !data.planVersionId)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either planSlug or planVersionId is required",
        path: ["planSlug", "planVersionId"],
      })
    if (data.planSlug && data.planVersionId)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only one of planSlug or planVersionId should be provided",
        path: ["planSlug", "planVersionId"],
      })
  })

export const signUpResponseSchema = z.object({
  success: z.boolean().openapi({
    description: "Whether the signup was successful",
    example: true,
  }),
  url: z.string().url().openapi({
    description: "The url to redirect the customer to, either to the success or cancel url",
    example: "https://example.com/dashboard",
  }),
  customerId: z.string().openapi({
    description: "The unprice customer id generated by the system for this customer",
    example: "cus_1234567890",
  }),
})

export const createPaymentMethodSchema = z.object({
  paymentProvider: paymentProviderSchema.openapi({
    description: "The payment provider code to use",
    example: "stripe",
  }),
  customerId: z.string().openapi({
    description: "The unprice customer id generated by the system for this customer",
    example: "cus_1234567890",
  }),
  successUrl: z.string().url().openapi({
    description: "The success url if the customer signs up",
    example: "https://example.com/dashboard",
  }),
  cancelUrl: z.string().url().openapi({
    description: "The cancel url if the customer cancels the signup",
    example: "https://example.com/login",
  }),
})

export const createPaymentMethodResponseSchema = z.object({
  success: z.boolean().openapi({
    description: "Whether the signup was successful",
    example: true,
  }),
  url: z.string().url().openapi({
    description: "The url to redirect the customer to, either to the success or cancel url",
    example: "https://example.com/dashboard",
  }),
})

export const customerSessionCustomerSchema = z.object({
  id: z.string().min(1, "Customer id is required"),
  name: z.string().optional(),
  email: z.string().email(),
  currency: currencySchema,
  timezone: z.string().min(1, "Timezone is required"),
  projectId: z.string().min(1, "Project id is required"),
  externalId: z.string().optional(),
  metadata: customerMetadataSchema.optional(),
})

export const customerSetUpSchema = z.object({
  id: z.string().min(1, "Customer id is required"),
  projectId: z.string().min(1, "Project id is required"),
  externalId: z.string().optional(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  paymentProvider: paymentProviderSchema,
})

export const customerSessionPlanVersionSchema = z.object({
  id: z.string().min(1, "Plan version id is required"),
  projectId: z.string().min(1, "Project id is required"),
  config: subscriptionItemsConfigSchema.optional(),
  paymentMethodRequired: z.boolean(),
})

export const customerSessionMetadataSchema = z.object({
  sessionId: z.string().optional(),
  pageId: z.string().optional(),
})

export const customerPaymentMethodSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  last4: z.string().optional(),
  expMonth: z.number().optional(),
  expYear: z.number().optional(),
  brand: z.string().optional(),
})

export type Customer = z.infer<typeof customerSelectSchema>
export type InsertCustomer = z.infer<typeof customerInsertBaseSchema>
export type CustomerSessionCustomer = z.infer<typeof customerSessionCustomerSchema>
export type CustomerSignUp = z.infer<typeof customerSignUpSchema>
export type CustomerSetUp = z.infer<typeof customerSetUpSchema>
export type CustomerPaymentMethod = z.infer<typeof customerPaymentMethodSchema>
export type CustomerSessionPlanVersion = z.infer<typeof customerSessionPlanVersionSchema>
