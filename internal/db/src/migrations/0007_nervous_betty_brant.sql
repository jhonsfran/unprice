CREATE TABLE "unprice_entitlement_reservation_funding_legs" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"reservation_id" varchar(36) COLLATE "C" NOT NULL,
	"source" text NOT NULL,
	"wallet_credit_id" varchar(36) COLLATE "C",
	"grant_source" "wallet_credit_source",
	"allocated_amount" bigint NOT NULL,
	"captured_amount" bigint DEFAULT 0 NOT NULL,
	"released_amount" bigint DEFAULT 0 NOT NULL,
	"sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_reservation_funding_legs_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_wallet_command_idempotency" (
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"idempotency_key" text NOT NULL,
	"command" text NOT NULL,
	"payload_hash" text NOT NULL,
	"result" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_command_idempotency_pkey" PRIMARY KEY("project_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "unprice_entitlement_reservation_funding_legs" ADD CONSTRAINT "unprice_entitlement_reservation_funding_legs_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_entitlement_reservation_funding_legs" ADD CONSTRAINT "entitlement_reservation_funding_legs_reservation_id_fkey" FOREIGN KEY ("reservation_id","project_id") REFERENCES "public"."unprice_entitlement_reservations"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_entitlement_reservation_funding_legs" ADD CONSTRAINT "entitlement_reservation_funding_legs_wallet_credit_id_fkey" FOREIGN KEY ("wallet_credit_id","project_id") REFERENCES "public"."unprice_wallet_credits"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_wallet_command_idempotency" ADD CONSTRAINT "wallet_command_idempotency_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_reservation_funding_legs_res_seq_idx" ON "unprice_entitlement_reservation_funding_legs" USING btree ("project_id","reservation_id","sequence");--> statement-breakpoint
CREATE INDEX "entitlement_reservation_funding_legs_reservation_idx" ON "unprice_entitlement_reservation_funding_legs" USING btree ("project_id","reservation_id");--> statement-breakpoint
CREATE INDEX "entitlement_reservation_funding_legs_wallet_credit_idx" ON "unprice_entitlement_reservation_funding_legs" USING btree ("project_id","wallet_credit_id");--> statement-breakpoint
ALTER TABLE "unprice_entitlement_reservations" DROP COLUMN "drain_legs";