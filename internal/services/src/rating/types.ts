import type {
  CalculatedPrice,
  Currency,
  Entitlement,
  grantSchemaExtended,
} from "@unprice/db/validators"
import type { z } from "zod"

export interface BillingWindow {
  billingStartAt: number
  billingEndAt: number
}

export interface UsageFeatureData {
  featureSlug: string
  usage: number
}

export interface RatedCharge {
  grantId?: string | null
  price: CalculatedPrice
  prorate: number
  cycleStartAt: number
  cycleEndAt: number
  usage: number
  included: number
  limit: number
  isTrial: boolean
}

export type RatingInput =
  | {
      projectId: string
      customerId: string
      featureSlug: string
      now: number
      grants?: z.infer<typeof grantSchemaExtended>[]
      entitlement?: Omit<Entitlement, "id">
      startAt?: never
      endAt?: never
      usageData?: UsageFeatureData[]
    }
  | {
      projectId: string
      customerId: string
      featureSlug: string
      startAt: number
      endAt: number
      grants?: z.infer<typeof grantSchemaExtended>[]
      entitlement?: Omit<Entitlement, "id">
      now?: never
      usageData?: UsageFeatureData[]
    }

export type ResolveBillingWindowInput =
  | {
      entitlement: Omit<Entitlement, "id">
      now: number
      startAt?: never
      endAt?: never
    }
  | {
      entitlement: Omit<Entitlement, "id">
      startAt: number
      endAt: number
      now?: never
    }

type RatingTimeWindowInput =
  | {
      now: number
      startAt?: never
      endAt?: never
    }
  | {
      startAt: number
      endAt: number
      now?: never
    }

export type IncrementalRatingInput = RatingTimeWindowInput & {
  projectId: string
  customerId: string
  featureSlug: string
  usageBefore: number
  usageAfter: number
  grants?: z.infer<typeof grantSchemaExtended>[]
  entitlement?: Omit<Entitlement, "id">
  currency?: Currency
  usageDataBefore?: UsageFeatureData[]
  usageDataAfter?: UsageFeatureData[]
}

export interface IncrementalRatingResult {
  usageBefore: number
  usageAfter: number
  usageDelta: number
  before: RatedCharge[]
  after: RatedCharge[]
  deltaPrice: CalculatedPrice
}
