import { pgEnum } from "drizzle-orm/pg-core"

import {
  AGGREGATION_METHODS,
  BILLING_INTERVALS,
  BILLING_PERIOD_STATUS,
  BILLING_PERIOD_TYPE,
  COLLECTION_METHODS,
  CURRENCIES,
  DUE_BEHAVIOUR,
  ENTITLEMENT_MERGING_POLICY,
  FEATURE_CONFIG_TYPES,
  FEATURE_TYPES,
  GRANT_TYPES,
  INVOICE_ITEM_KIND,
  INVOICE_STATUS,
  OVERAGE_STRATEGIES,
  PAYMENT_PROVIDERS,
  PLAN_TYPES,
  ROLES_APP,
  STAGES,
  STATUS_PLAN,
  SUBJECT_TYPES,
  SUBSCRIPTION_STATUS,
  TIER_MODES,
  USAGE_MODES,
  WHEN_TO_BILLING,
} from "../utils"

export const subscriptionStatusEnum = pgEnum("subscription_status_v3", SUBSCRIPTION_STATUS)
export const billingPeriodStatusEnum = pgEnum("billing_period_status_v1", BILLING_PERIOD_STATUS)
export const billingPeriodTypeEnum = pgEnum("billing_period_type", BILLING_PERIOD_TYPE)
export const invoiceStatusEnum = pgEnum("invoice_status", INVOICE_STATUS)
export const statusPlanEnum = pgEnum("plan_version_status", STATUS_PLAN)
export const entitlementMergingPolicyEnum = pgEnum("merging_policy", ENTITLEMENT_MERGING_POLICY)
export const grantTypeEnum = pgEnum("grant_type", GRANT_TYPES)
export const subjectTypeEnum = pgEnum("subject_type", SUBJECT_TYPES)
export const typeFeatureEnum = pgEnum("feature_types", FEATURE_TYPES)
export const typeFeatureConfigEnum = pgEnum("feature_config_types", FEATURE_CONFIG_TYPES)
export const aggregationMethodEnum = pgEnum("aggregation_method", AGGREGATION_METHODS)
export const tierModeEnum = pgEnum("tier_mode", TIER_MODES)
export const usageModeEnum = pgEnum("usage_mode", USAGE_MODES)
export const paymentProviderEnum = pgEnum("payment_providers", PAYMENT_PROVIDERS)
export const dueBehaviourEnum = pgEnum("due_behaviour", DUE_BEHAVIOUR)
export const currencyEnum = pgEnum("currency", CURRENCIES)
export const stageEnum = pgEnum("app_stages", STAGES)
export const teamRolesEnum = pgEnum("team_roles", ROLES_APP)
export const billingIntervalEnum = pgEnum("billing_interval", BILLING_INTERVALS)
export const planTypeEnum = pgEnum("plan_type", PLAN_TYPES)
export const whenToBillEnum = pgEnum("when_to_bill", WHEN_TO_BILLING)
export const collectionMethodEnum = pgEnum("collection_method", COLLECTION_METHODS)
export const invoiceItemKindEnum = pgEnum("invoice_item_kind", INVOICE_ITEM_KIND)
export const overageStrategyEnum = pgEnum("overage_strategy", OVERAGE_STRATEGIES)
