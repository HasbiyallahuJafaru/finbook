CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"currency" char(3),
	"parent_id" uuid,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_tenant_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "accounts_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "accounts_type" CHECK ("accounts"."type" in ('asset', 'liability', 'equity', 'income', 'expense'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"ip" "inet",
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"memo" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"reverses_entry_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "journal_entries_idempotency" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "journal_entries_reversed_once" UNIQUE("reverses_entry_id")
);
--> statement-breakpoint
CREATE TABLE "journal_entry_hashes" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entry_hashes_seq" UNIQUE("tenant_id","seq")
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"debit_ngn" bigint DEFAULT 0 NOT NULL,
	"credit_ngn" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'NGN' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"rate" numeric(18, 6),
	"rate_source" text,
	"rate_note" text,
	CONSTRAINT "journal_lines_one_side" CHECK ("journal_lines"."debit_ngn" >= 0 and "journal_lines"."credit_ngn" >= 0 and ("journal_lines"."debit_ngn" > 0) <> ("journal_lines"."credit_ngn" > 0)),
	CONSTRAINT "journal_lines_fx" CHECK (coalesce(case when "journal_lines"."currency" = 'NGN'
    then "journal_lines"."rate" is null and "journal_lines"."rate_source" is null and "journal_lines"."amount_minor" = "journal_lines"."debit_ngn" + "journal_lines"."credit_ngn"
    else "journal_lines"."rate" > 0 and "journal_lines"."amount_minor" > 0
      and "journal_lines"."rate_source" in ('bank_receipt', 'bdc_receipt', 'agent_invoice', 'manual')
      and ("journal_lines"."rate_source" <> 'manual' or "journal_lines"."rate_note" is not null)
      and "journal_lines"."debit_ngn" + "journal_lines"."credit_ngn" = round("journal_lines"."amount_minor" * "journal_lines"."rate")
    end, false))
);
--> statement-breakpoint
CREATE TABLE "periods" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	CONSTRAINT "periods_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "periods_dates" CHECK ("periods"."ends_on" >= "periods"."starts_on"),
	CONSTRAINT "periods_status" CHECK ("periods"."status" in ('open', 'closing', 'locked')),
	CONSTRAINT "periods_locked_by" CHECK ("periods"."status" <> 'locked' or ("periods"."locked_by" is not null and "periods"."locked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"clerk_org_id" text,
	"legal_name" text NOT NULL,
	"functional_currency" char(3) DEFAULT 'NGN' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_clerk_org_id_unique" UNIQUE("clerk_org_id"),
	CONSTRAINT "tenants_status" CHECK ("tenants"."status" in ('active', 'suspended', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_period" FOREIGN KEY ("tenant_id","period_id") REFERENCES "public"."periods"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses" FOREIGN KEY ("tenant_id","reverses_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_hashes" ADD CONSTRAINT "journal_entry_hashes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_hashes" ADD CONSTRAINT "journal_entry_hashes_entry" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periods" ADD CONSTRAINT "periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_tenant_at" ON "audit_log" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "journal_entries_tenant_date" ON "journal_entries" USING btree ("tenant_id","entry_date");--> statement-breakpoint
CREATE INDEX "journal_lines_tenant_account" ON "journal_lines" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_entry" ON "journal_lines" USING btree ("entry_id");