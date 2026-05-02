CREATE TYPE "public"."aggregation_method" AS ENUM('sum', 'count', 'max', 'latest');--> statement-breakpoint
CREATE TYPE "public"."billing_interval" AS ENUM('month', 'year', 'week', 'day', 'minute', 'onetime');--> statement-breakpoint
CREATE TYPE "public"."billing_period_status_v1" AS ENUM('pending', 'invoiced', 'voided');--> statement-breakpoint
CREATE TYPE "public"."billing_period_type" AS ENUM('normal', 'trial');--> statement-breakpoint
CREATE TYPE "public"."collection_method" AS ENUM('charge_automatically', 'send_invoice');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('USD', 'EUR');--> statement-breakpoint
CREATE TYPE "public"."due_behaviour" AS ENUM('cancel', 'downgrade');--> statement-breakpoint
CREATE TYPE "public"."merging_policy" AS ENUM('sum', 'max', 'min', 'replace');--> statement-breakpoint
CREATE TYPE "public"."grant_type" AS ENUM('subscription', 'manual', 'promotion', 'trial', 'addon');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('unpaid', 'paid', 'waiting', 'void', 'draft', 'failed');--> statement-breakpoint
CREATE TYPE "public"."overage_strategy" AS ENUM('none', 'last-call', 'always');--> statement-breakpoint
CREATE TYPE "public"."payment_providers" AS ENUM('stripe', 'square', 'sandbox');--> statement-breakpoint
CREATE TYPE "public"."plan_type" AS ENUM('recurring', 'onetime');--> statement-breakpoint
CREATE TYPE "public"."app_stages" AS ENUM('prod', 'test', 'dev');--> statement-breakpoint
CREATE TYPE "public"."plan_version_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."subject_type" AS ENUM('project', 'plan', 'plan_version', 'customer');--> statement-breakpoint
CREATE TYPE "public"."subscription_status_v3" AS ENUM('active', 'trialing', 'pending_payment', 'pending_activation', 'canceled', 'expired', 'past_due');--> statement-breakpoint
CREATE TYPE "public"."team_roles" AS ENUM('OWNER', 'ADMIN', 'MEMBER');--> statement-breakpoint
CREATE TYPE "public"."tier_mode" AS ENUM('volume', 'graduated');--> statement-breakpoint
CREATE TYPE "public"."feature_config_types" AS ENUM('feature', 'addon');--> statement-breakpoint
CREATE TYPE "public"."feature_types" AS ENUM('flat', 'tier', 'package', 'usage');--> statement-breakpoint
CREATE TYPE "public"."usage_mode" AS ENUM('tier', 'package', 'unit');--> statement-breakpoint
CREATE TYPE "public"."wallet_grant_source" AS ENUM('promo', 'plan_included', 'trial', 'manual', 'credit_line');--> statement-breakpoint
CREATE TYPE "public"."wallet_topup_status" AS ENUM('pending', 'completed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."when_to_bill" AS ENUM('pay_in_advance', 'pay_in_arrear');--> statement-breakpoint
CREATE TABLE "unprice_apikeys" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"expires_at_m" bigint,
	"last_used_m" bigint,
	"revoked_at_m" bigint,
	"is_root" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"hash" text DEFAULT '' NOT NULL,
	"default_customer_id" varchar(36) COLLATE "C",
	CONSTRAINT "pk_apikeys" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_account" (
	"userId" varchar(36) COLLATE "C" NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "unprice_account_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "unprice_authenticator" (
	"credentialID" text NOT NULL,
	"userId" varchar(36) COLLATE "C" NOT NULL,
	"providerAccountId" text NOT NULL,
	"credentialPublicKey" text NOT NULL,
	"counter" integer NOT NULL,
	"credentialDeviceType" text NOT NULL,
	"credentialBackedUp" boolean NOT NULL,
	"transports" text,
	CONSTRAINT "unprice_authenticator_userId_credentialID_pk" PRIMARY KEY("userId","credentialID"),
	CONSTRAINT "unprice_authenticator_credentialID_unique" UNIQUE("credentialID")
);
--> statement-breakpoint
CREATE TABLE "unprice_session" (
	"sessionToken" varchar(36) COLLATE "C" PRIMARY KEY NOT NULL,
	"userId" varchar(36) COLLATE "C" NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unprice_user" (
	"id" varchar(36) COLLATE "C" PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"emailVerified" timestamp,
	"image" text,
	"theme" text DEFAULT 'dark' NOT NULL,
	"default_wk_slug" text,
	"password" varchar(255),
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"onboarding_completed_at" timestamp,
	CONSTRAINT "unprice_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "unprice_verificationToken" (
	"identifier" varchar(36) COLLATE "C" NOT NULL,
	"token" varchar(36) COLLATE "C" NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "unprice_verificationToken_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "unprice_customer_sessions" (
	"id" varchar(36) COLLATE "C" PRIMARY KEY NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"customer" json NOT NULL,
	"plan_version" json NOT NULL,
	"metadata" json
);
--> statement-breakpoint
CREATE TABLE "unprice_customers" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"external_id" text,
	"metadata" json,
	"active" boolean DEFAULT true NOT NULL,
	"is_main" boolean DEFAULT false NOT NULL,
	"default_currency" "currency" DEFAULT 'USD' NOT NULL,
	"timezone" varchar(32) DEFAULT 'UTC' NOT NULL,
	CONSTRAINT "pk_customer" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_domains" (
	"id" varchar(36) COLLATE "C" PRIMARY KEY NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"workspace_id" varchar(36) COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"apex_name" text NOT NULL,
	"verified" boolean DEFAULT false,
	CONSTRAINT "unprice_domains_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "unprice_events" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(64) NOT NULL,
	"available_properties" json,
	CONSTRAINT "events_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_features" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"slug" text NOT NULL,
	"code" serial NOT NULL,
	"unit_of_measure" varchar(24) DEFAULT 'units' NOT NULL,
	"title" varchar(50) NOT NULL,
	"description" text,
	"meter_config" json,
	CONSTRAINT "features_pkey" PRIMARY KEY("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "unprice_billing_periods" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"subscription_id" varchar(36) COLLATE "C" NOT NULL,
	"customer_id" varchar(36) COLLATE "C" NOT NULL,
	"subscription_phase_id" varchar(36) COLLATE "C" NOT NULL,
	"subscription_item_id" varchar(36) COLLATE "C" NOT NULL,
	"status" "billing_period_status_v1" DEFAULT 'pending' NOT NULL,
	"type" "billing_period_type" DEFAULT 'normal' NOT NULL,
	"cycle_start_at_m" bigint NOT NULL,
	"cycle_end_at_m" bigint NOT NULL,
	"amount_estimate_cents" integer,
	"reason" varchar(64),
	"invoice_id" varchar(36) COLLATE "C",
	"when_to_bill" "when_to_bill" DEFAULT 'pay_in_advance' NOT NULL,
	"invoice_at_m" bigint NOT NULL,
	"statement_key" varchar(64) NOT NULL,
	CONSTRAINT "billing_periods_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_invoices" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"subscription_id" varchar(36) COLLATE "C" NOT NULL,
	"customer_id" varchar(36) COLLATE "C" NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"issue_date_m" bigint,
	"required_payment_method" boolean DEFAULT false NOT NULL,
	"payment_method_id" text,
	"statement_date_string" varchar(255) NOT NULL,
	"statement_key" varchar(64) NOT NULL,
	"statement_start_at_m" bigint NOT NULL,
	"statement_end_at_m" bigint NOT NULL,
	"when_to_bill" "when_to_bill" DEFAULT 'pay_in_advance' NOT NULL,
	"collection_method" "collection_method" DEFAULT 'charge_automatically' NOT NULL,
	"payment_providers" "payment_providers" NOT NULL,
	"currency" "currency" NOT NULL,
	"sent_at_m" bigint,
	"due_at_m" bigint NOT NULL,
	"paid_at_m" bigint,
	"total_amount" bigint DEFAULT 0 NOT NULL,
	"invoice_payment_provider_id" text,
	"invoice_payment_provider_url" text,
	"past_due_at_m" bigint NOT NULL,
	"metadata" json,
	CONSTRAINT "invoices_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_ledger_idempotency" (
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"transfer_id" text,
	"statement_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_idempotency_pkey" PRIMARY KEY("project_id","source_type","source_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_pages" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"custom_domain" text,
	"subdomain" text NOT NULL,
	"slug" text NOT NULL,
	"cta_link" text DEFAULT '' NOT NULL,
	"description" text,
	"title" text DEFAULT '' NOT NULL,
	"copy" text DEFAULT '' NOT NULL,
	"faqs" jsonb NOT NULL,
	"color_palette" jsonb NOT NULL,
	"selected_plans" jsonb NOT NULL,
	"logo" text,
	"logo_type" text,
	"font" text,
	"published" boolean DEFAULT false NOT NULL,
	CONSTRAINT "page_pkey" PRIMARY KEY("id","project_id"),
	CONSTRAINT "unprice_pages_custom_domain_unique" UNIQUE("custom_domain"),
	CONSTRAINT "unprice_pages_subdomain_unique" UNIQUE("subdomain")
);
--> statement-breakpoint
CREATE TABLE "unprice_payment_provider_config" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"payment_provider" "payment_providers" DEFAULT 'stripe' NOT NULL,
	"key" text NOT NULL,
	"key_iv" text NOT NULL,
	"webhook_secret" text,
	"webhook_secret_iv" text,
	CONSTRAINT "pk_ppconfig" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_plans" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"active" boolean DEFAULT true,
	"description" text NOT NULL,
	"metadata" json,
	"default_plan" boolean DEFAULT false,
	"enterprise_plan" boolean DEFAULT false,
	CONSTRAINT "plans_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_plan_versions_features" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"plan_version_id" varchar(36) COLLATE "C" NOT NULL,
	"feature_config_type" "feature_config_types" DEFAULT 'feature' NOT NULL,
	"feature_id" varchar(36) COLLATE "C" NOT NULL,
	"feature_type" "feature_types" NOT NULL,
	"unit_of_measure" varchar(24) DEFAULT 'units' NOT NULL,
	"features_config" json NOT NULL,
	"billing_config" json NOT NULL,
	"reset_config" json,
	"metadata" json,
	"order" double precision NOT NULL,
	"default_quantity" integer DEFAULT 1,
	"limit" integer,
	"meter_config" json,
	CONSTRAINT "plan_versions_pkey" PRIMARY KEY("id","project_id"),
	CONSTRAINT "unique_version_feature" UNIQUE NULLS NOT DISTINCT("plan_version_id","feature_id","project_id","order")
);
--> statement-breakpoint
CREATE TABLE "unprice_plan_versions" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"plan_id" varchar(36) COLLATE "C" NOT NULL,
	"description" text NOT NULL,
	"latest" boolean DEFAULT false,
	"title" varchar(50) NOT NULL,
	"tags" json,
	"active" boolean DEFAULT true,
	"plan_version_status" "plan_version_status" DEFAULT 'draft',
	"published_at_m" bigint,
	"published_by" varchar(36) COLLATE "C",
	"archived" boolean DEFAULT false,
	"archived_at_m" bigint,
	"archived_by" varchar(36) COLLATE "C",
	"payment_providers" "payment_providers" NOT NULL,
	"due_behaviour" "due_behaviour" DEFAULT 'cancel' NOT NULL,
	"currency" "currency" NOT NULL,
	"billing_config" json NOT NULL,
	"when_to_bill" "when_to_bill" DEFAULT 'pay_in_advance' NOT NULL,
	"grace_period" integer DEFAULT 0 NOT NULL,
	"collection_method" "collection_method" DEFAULT 'charge_automatically' NOT NULL,
	"trial_units" integer DEFAULT 0 NOT NULL,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"credit_line_amount" bigint DEFAULT 0 NOT NULL,
	"metadata" json,
	"payment_method_required" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "plan_versions_plan_id_fkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_customer_provider_ids" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"customer_id" varchar(36) COLLATE "C" NOT NULL,
	"provider" "payment_providers" NOT NULL,
	"provider_customer_id" text NOT NULL,
	"metadata" json,
	CONSTRAINT "customer_provider_ids_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_webhook_events" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"provider" "payment_providers" NOT NULL,
	"provider_event_id" text NOT NULL,
	"raw_payload" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"signature" text,
	"headers" json,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at_m" bigint,
	"error_payload" json,
	CONSTRAINT "webhook_events_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_projects" (
	"id" varchar(36) COLLATE "C" PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"is_main" boolean DEFAULT false,
	"default_currency" "currency" NOT NULL,
	"timezone" varchar(32) NOT NULL,
	"contact_email" text DEFAULT '' NOT NULL,
	"metadata" json,
	CONSTRAINT "unique_slug" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "unprice_subscription_items" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"units" integer,
	"feature_plan_version_id" varchar(36) COLLATE "C" NOT NULL,
	"subscription_phase_id" varchar(36) COLLATE "C" NOT NULL,
	"subscription_id" varchar(36) COLLATE "C" NOT NULL,
	CONSTRAINT "subscription_items_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_subscription_phases" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"subscription_id" varchar(36) COLLATE "C" NOT NULL,
	"plan_version_id" varchar(36) COLLATE "C" NOT NULL,
	"payment_method_id" text,
	"payment_provider" "payment_providers" DEFAULT 'sandbox' NOT NULL,
	"trial_units" integer DEFAULT 0 NOT NULL,
	"billing_anchor" integer DEFAULT 0 NOT NULL,
	"trial_ends_at_m" bigint,
	"start_at_m" bigint NOT NULL,
	"end_at_m" bigint,
	"metadata" json,
	CONSTRAINT "subscription_phases_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_subscriptions" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"customers_id" varchar(36) COLLATE "C" NOT NULL,
	"status" "subscription_status_v3" DEFAULT 'active' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"plan_slug" text DEFAULT 'FREE' NOT NULL,
	"current_cycle_start_at_m" bigint NOT NULL,
	"current_cycle_end_at_m" bigint NOT NULL,
	"renew_at_m" bigint,
	"end_at_m" bigint,
	"timezone" varchar(32) DEFAULT 'UTC' NOT NULL,
	"metadata" json,
	CONSTRAINT "subscriptions_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_subscription_locks" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"subscription_id" varchar(32) NOT NULL,
	"owner_token" varchar(64) NOT NULL,
	"expires_at_m" bigint NOT NULL,
	CONSTRAINT "subscription_locks_pk" PRIMARY KEY("project_id","subscription_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_invites" (
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"workspace_id" varchar(36) COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" "team_roles" DEFAULT 'MEMBER' NOT NULL,
	"accepted_at_m" bigint,
	"invited_by" varchar(36) COLLATE "C" NOT NULL,
	CONSTRAINT "invites_pkey" PRIMARY KEY("email","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_members" (
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"workspace_id" varchar(36) COLLATE "C" NOT NULL,
	"user_id" varchar(36) COLLATE "C" NOT NULL,
	"role" "team_roles" DEFAULT 'MEMBER' NOT NULL,
	CONSTRAINT "members_pkey" PRIMARY KEY("user_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_workspaces" (
	"id" varchar(36) COLLATE "C" PRIMARY KEY NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"is_personal" boolean DEFAULT false NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"is_main" boolean DEFAULT false NOT NULL,
	"created_by" varchar(36) COLLATE "C" NOT NULL,
	"image_url" text,
	"unprice_customer_id" text NOT NULL,
	"plan" text,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "unprice_workspaces_slug_unique" UNIQUE("slug"),
	CONSTRAINT "unprice_customer_id" UNIQUE("unprice_customer_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_customer_entitlements" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"customer_id" varchar(36) COLLATE "C" NOT NULL,
	"feature_plan_version_id" varchar(36) COLLATE "C" NOT NULL,
	"subscription_id" varchar(36) COLLATE "C",
	"subscription_phase_id" varchar(36) COLLATE "C",
	"subscription_item_id" varchar(36) COLLATE "C",
	"effective_at" bigint NOT NULL,
	"expires_at" bigint,
	"overage_strategy" "overage_strategy" DEFAULT 'none' NOT NULL,
	"metadata" json,
	CONSTRAINT "customer_entitlements_pkey" PRIMARY KEY("id","project_id"),
	CONSTRAINT "unique_customer_entitlement_source_window" UNIQUE NULLS NOT DISTINCT("project_id","customer_id","feature_plan_version_id","subscription_id","subscription_phase_id","subscription_item_id","effective_at","expires_at")
);
--> statement-breakpoint
CREATE TABLE "unprice_grants" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"customer_entitlement_id" varchar(36) COLLATE "C" NOT NULL,
	"type" "grant_type" NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"allowance_units" integer,
	"effective_at" bigint NOT NULL,
	"expires_at" bigint,
	"metadata" json,
	CONSTRAINT "pk_grant" PRIMARY KEY("id","project_id"),
	CONSTRAINT "unique_grant" UNIQUE NULLS NOT DISTINCT("project_id","customer_entitlement_id","type","effective_at","expires_at")
);
--> statement-breakpoint
CREATE TABLE "unprice_entitlement_reservations" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"customer_id" varchar(36) COLLATE "C" NOT NULL,
	"entitlement_id" varchar(36) COLLATE "C" NOT NULL,
	"allocation_amount" bigint NOT NULL,
	"consumed_amount" bigint DEFAULT 0 NOT NULL,
	"refill_threshold_bps" integer DEFAULT 2000 NOT NULL,
	"refill_chunk_amount" bigint NOT NULL,
	"period_start_at" timestamp with time zone NOT NULL,
	"period_end_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciled_at" timestamp with time zone,
	CONSTRAINT "entitlement_reservations_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_wallet_topups" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"customer_id" varchar(36) COLLATE "C" NOT NULL,
	"provider" text NOT NULL,
	"provider_session_id" text NOT NULL,
	"requested_amount" bigint NOT NULL,
	"currency" "currency" NOT NULL,
	"status" "wallet_topup_status" NOT NULL,
	"settled_amount" bigint,
	"ledger_transfer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "wallet_topups_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_wallet_grants" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"customer_id" varchar(36) COLLATE "C" NOT NULL,
	"source" "wallet_grant_source" NOT NULL,
	"issued_amount" bigint NOT NULL,
	"remaining_amount" bigint NOT NULL,
	"expires_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"ledger_transfer_id" text NOT NULL,
	"metadata" json,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_grants_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
ALTER TABLE "unprice_apikeys" ADD CONSTRAINT "unprice_apikeys_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_apikeys" ADD CONSTRAINT "apikeys_default_customer_id_fkey" FOREIGN KEY ("default_customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_account" ADD CONSTRAINT "unprice_account_userId_unprice_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."unprice_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_authenticator" ADD CONSTRAINT "unprice_authenticator_userId_unprice_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."unprice_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_session" ADD CONSTRAINT "unprice_session_userId_unprice_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."unprice_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customers" ADD CONSTRAINT "unprice_customers_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customers" ADD CONSTRAINT "project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_domains" ADD CONSTRAINT "fk_domain_workspace" FOREIGN KEY ("workspace_id") REFERENCES "public"."unprice_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_events" ADD CONSTRAINT "unprice_events_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_features" ADD CONSTRAINT "unprice_features_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "unprice_billing_periods_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "billing_periods_subscription_id_fkey" FOREIGN KEY ("subscription_id","project_id") REFERENCES "public"."unprice_subscriptions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "billing_periods_subscription_phase_id_fkey" FOREIGN KEY ("subscription_phase_id","project_id") REFERENCES "public"."unprice_subscription_phases"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "billing_periods_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "billing_periods_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "billing_periods_subscription_item_id_fkey" FOREIGN KEY ("subscription_item_id","project_id") REFERENCES "public"."unprice_subscription_items"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "billing_periods_invoice_id_fkey" FOREIGN KEY ("invoice_id","project_id") REFERENCES "public"."unprice_invoices"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoices" ADD CONSTRAINT "unprice_invoices_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoices" ADD CONSTRAINT "invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id","project_id") REFERENCES "public"."unprice_subscriptions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoices" ADD CONSTRAINT "invoices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_pages" ADD CONSTRAINT "unprice_pages_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_payment_provider_config" ADD CONSTRAINT "unprice_payment_provider_config_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_plans" ADD CONSTRAINT "unprice_plans_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" ADD CONSTRAINT "unprice_plan_versions_features_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" ADD CONSTRAINT "plan_versions_id_fkey" FOREIGN KEY ("plan_version_id","project_id") REFERENCES "public"."unprice_plan_versions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" ADD CONSTRAINT "features_id_fkey" FOREIGN KEY ("feature_id","project_id") REFERENCES "public"."unprice_features"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions" ADD CONSTRAINT "unprice_plan_versions_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions" ADD CONSTRAINT "unprice_plan_versions_published_by_unprice_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."unprice_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions" ADD CONSTRAINT "unprice_plan_versions_archived_by_unprice_user_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."unprice_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions" ADD CONSTRAINT "plan_versions_plan_id_pkey" FOREIGN KEY ("plan_id","project_id") REFERENCES "public"."unprice_plans"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_provider_ids" ADD CONSTRAINT "unprice_customer_provider_ids_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_provider_ids" ADD CONSTRAINT "customer_provider_ids_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_webhook_events" ADD CONSTRAINT "unprice_webhook_events_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_projects" ADD CONSTRAINT "fk_project_workspace" FOREIGN KEY ("workspace_id") REFERENCES "public"."unprice_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_subscription_items" ADD CONSTRAINT "unprice_subscription_items_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_subscription_items" ADD CONSTRAINT "subscription_items_plan_version_id_fkey" FOREIGN KEY ("feature_plan_version_id","project_id") REFERENCES "public"."unprice_plan_versions_features"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_subscription_items" ADD CONSTRAINT "subscription_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_subscription_items" ADD CONSTRAINT "subscription_items_subscription_phase_id_fkey" FOREIGN KEY ("subscription_phase_id","project_id") REFERENCES "public"."unprice_subscription_phases"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_subscription_items" ADD CONSTRAINT "subscription_items_subscription_id_fkey" FOREIGN KEY ("subscription_id","project_id") REFERENCES "public"."unprice_subscriptions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_subscription_phases" ADD CONSTRAINT "unprice_subscription_phases_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_subscription_phases" ADD CONSTRAINT "subscription_phases_plan_version_id_fkey" FOREIGN KEY ("plan_version_id","project_id") REFERENCES "public"."unprice_plan_versions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_subscription_phases" ADD CONSTRAINT "subscription_phases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_subscription_phases" ADD CONSTRAINT "subscription_phases_subscription_id_fkey" FOREIGN KEY ("subscription_id","project_id") REFERENCES "public"."unprice_subscriptions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_subscriptions" ADD CONSTRAINT "unprice_subscriptions_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_subscriptions" ADD CONSTRAINT "subscriptions_customer_id_fkey" FOREIGN KEY ("customers_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_subscriptions" ADD CONSTRAINT "subscriptions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_subscription_locks" ADD CONSTRAINT "unprice_subscription_locks_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invites" ADD CONSTRAINT "invites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."unprice_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invites" ADD CONSTRAINT "invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."unprice_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_members" ADD CONSTRAINT "members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."unprice_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_members" ADD CONSTRAINT "members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."unprice_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_workspaces" ADD CONSTRAINT "unprice_workspaces_created_by_unprice_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."unprice_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "unprice_customer_entitlements_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "customer_entitlements_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "customer_entitlements_feature_plan_version_id_fkey" FOREIGN KEY ("feature_plan_version_id","project_id") REFERENCES "public"."unprice_plan_versions_features"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "customer_entitlements_subscription_id_fkey" FOREIGN KEY ("subscription_id","project_id") REFERENCES "public"."unprice_subscriptions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "customer_entitlements_subscription_phase_id_fkey" FOREIGN KEY ("subscription_phase_id","project_id") REFERENCES "public"."unprice_subscription_phases"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "customer_entitlements_subscription_item_id_fkey" FOREIGN KEY ("subscription_item_id","project_id") REFERENCES "public"."unprice_subscription_items"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD CONSTRAINT "unprice_grants_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD CONSTRAINT "grants_customer_entitlement_id_fkey" FOREIGN KEY ("customer_entitlement_id","project_id") REFERENCES "public"."unprice_customer_entitlements"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD CONSTRAINT "project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_entitlement_reservations" ADD CONSTRAINT "unprice_entitlement_reservations_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_entitlement_reservations" ADD CONSTRAINT "entitlement_reservations_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_entitlement_reservations" ADD CONSTRAINT "entitlement_reservations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_wallet_topups" ADD CONSTRAINT "unprice_wallet_topups_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_wallet_topups" ADD CONSTRAINT "wallet_topups_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_wallet_topups" ADD CONSTRAINT "wallet_topups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_wallet_grants" ADD CONSTRAINT "unprice_wallet_grants_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_wallet_grants" ADD CONSTRAINT "wallet_grants_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_wallet_grants" ADD CONSTRAINT "wallet_grants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apikeys_project_default_customer_idx" ON "unprice_apikeys" USING btree ("project_id","default_customer_id") WHERE "unprice_apikeys"."default_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hash" ON "unprice_apikeys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "email" ON "unprice_customers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "cp_external_id_idx" ON "unprice_customers" USING btree ("project_id","external_id") WHERE "unprice_customers"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_id" ON "unprice_customers" USING btree ("id");--> statement-breakpoint
CREATE INDEX "name" ON "unprice_domains" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_event_project_slug" ON "unprice_events" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "slug_feature" ON "unprice_features" USING btree ("slug","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_periods_period_unique" ON "unprice_billing_periods" USING btree ("project_id","subscription_id","subscription_phase_id","subscription_item_id","cycle_start_at_m","cycle_end_at_m");--> statement-breakpoint
CREATE INDEX "billing_periods_bill_at_idx" ON "unprice_billing_periods" USING btree ("project_id","status","invoice_at_m");--> statement-breakpoint
CREATE INDEX "billing_periods_statement_idx" ON "unprice_billing_periods" USING btree ("project_id","subscription_id","statement_key");--> statement-breakpoint
CREATE INDEX "invoices_period_idx" ON "unprice_invoices" USING btree ("project_id","subscription_id","customer_id","statement_start_at_m","statement_end_at_m");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_statement_key_idx" ON "unprice_invoices" USING btree ("project_id","subscription_id","customer_id","statement_key");--> statement-breakpoint
CREATE INDEX "ledger_idempotency_statement_key_idx" ON "unprice_ledger_idempotency" USING btree ("project_id","statement_key");--> statement-breakpoint
CREATE INDEX "ledger_idempotency_transfer_id_idx" ON "unprice_ledger_idempotency" USING btree ("transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slug_page" ON "unprice_pages" USING btree ("slug","project_id");--> statement-breakpoint
CREATE INDEX "subdomain_index" ON "unprice_pages" USING btree ("subdomain");--> statement-breakpoint
CREATE INDEX "custom_domain_index" ON "unprice_pages" USING btree ("custom_domain");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_payment_provider_config" ON "unprice_payment_provider_config" USING btree ("payment_provider","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slug_plan" ON "unprice_plans" USING btree ("slug","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_provider_ids_customer_provider_uq" ON "unprice_customer_provider_ids" USING btree ("project_id","customer_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_provider_ids_provider_customer_uq" ON "unprice_customer_provider_ids" USING btree ("project_id","provider","provider_customer_id");--> statement-breakpoint
CREATE INDEX "customer_provider_ids_customer_idx" ON "unprice_customer_provider_ids" USING btree ("project_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_uq" ON "unprice_webhook_events" USING btree ("project_id","provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "unprice_webhook_events" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "main_project" ON "unprice_projects" USING btree ("is_main") WHERE "unprice_projects"."is_main" = true;--> statement-breakpoint
CREATE INDEX "slug_index" ON "unprice_projects" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "phase_sub_window_uq" ON "unprice_subscription_phases" USING btree ("project_id","subscription_id","start_at_m","end_at_m");--> statement-breakpoint
CREATE INDEX "subscriptions_sub_renew_uq" ON "unprice_subscriptions" USING btree ("project_id","renew_at_m");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_locks_idx" ON "unprice_subscription_locks" USING btree ("project_id","subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "main_workspace" ON "unprice_workspaces" USING btree ("is_main") WHERE "unprice_workspaces"."is_main" = true;--> statement-breakpoint
CREATE INDEX "idx_customer_entitlements_customer_window" ON "unprice_customer_entitlements" USING btree ("project_id","customer_id","effective_at","expires_at");--> statement-breakpoint
CREATE INDEX "idx_customer_entitlements_phase_source" ON "unprice_customer_entitlements" USING btree ("project_id","customer_id","subscription_phase_id","feature_plan_version_id","effective_at","expires_at");--> statement-breakpoint
CREATE INDEX "idx_grants_customer_entitlement_effective" ON "unprice_grants" USING btree ("project_id","customer_entitlement_id","effective_at","expires_at","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_reservations_entitlement_period_idx" ON "unprice_entitlement_reservations" USING btree ("project_id","entitlement_id","period_start_at") WHERE "unprice_entitlement_reservations"."reconciled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "entitlement_reservations_customer_idx" ON "unprice_entitlement_reservations" USING btree ("project_id","customer_id");--> statement-breakpoint
CREATE INDEX "entitlement_reservations_active_period_end_idx" ON "unprice_entitlement_reservations" USING btree ("period_end_at") WHERE "unprice_entitlement_reservations"."reconciled_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_topups_provider_session_idx" ON "unprice_wallet_topups" USING btree ("provider","provider_session_id");--> statement-breakpoint
CREATE INDEX "wallet_topups_customer_created_idx" ON "unprice_wallet_topups" USING btree ("project_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "wallet_topups_pending_sweep_idx" ON "unprice_wallet_topups" USING btree ("created_at") WHERE "unprice_wallet_topups"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_grants_ledger_transfer_idx" ON "unprice_wallet_grants" USING btree ("customer_id","ledger_transfer_id");--> statement-breakpoint
CREATE INDEX "wallet_grants_active_customer_expiry_idx" ON "unprice_wallet_grants" USING btree ("customer_id","expires_at") WHERE "unprice_wallet_grants"."expired_at" IS NULL AND "unprice_wallet_grants"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "wallet_grants_expiration_sweep_idx" ON "unprice_wallet_grants" USING btree ("expires_at") WHERE "unprice_wallet_grants"."expired_at" IS NULL AND "unprice_wallet_grants"."voided_at" IS NULL AND "unprice_wallet_grants"."remaining_amount" > 0;
