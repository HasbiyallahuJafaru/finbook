CREATE TABLE "counterparties" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"tin" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterparties_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "counterparties_kind" CHECK ("counterparties"."kind" in ('supplier', 'agent', 'customer')),
	CONSTRAINT "counterparties_name" CHECK (btrim("counterparties"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" smallint NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vin" text NOT NULL,
	"vin_status" text GENERATED ALWAYS AS (vin_status_of(vin)) STORED NOT NULL,
	"make" text NOT NULL,
	"model" text NOT NULL,
	"year" smallint NOT NULL,
	"colour" text,
	"mileage" integer,
	"direction" text DEFAULT 'import' NOT NULL,
	"status" text DEFAULT 'purchased' NOT NULL,
	"purchase_date" date,
	"sold_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_tenant_vin" UNIQUE("tenant_id","vin"),
	CONSTRAINT "vehicles_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "vehicles_vin_shape" CHECK ("vehicles"."vin" = upper(btrim("vehicles"."vin")) AND "vehicles"."vin" <> ''),
	CONSTRAINT "vehicles_year" CHECK ("vehicles"."year" BETWEEN 1950 AND 2100),
	CONSTRAINT "vehicles_mileage" CHECK ("vehicles"."mileage" >= 0),
	CONSTRAINT "vehicles_direction" CHECK ("vehicles"."direction" in ('import', 'export', 'local')),
	CONSTRAINT "vehicles_status" CHECK ("vehicles"."status" in ('purchased', 'in_transit', 'at_port', 'in_yard', 'reserved', 'sold', 'delivered', 'written_off', 'returned'))
);
--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "counterparties_tenant_kind" ON "counterparties" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "vehicles_tenant_status" ON "vehicles" USING btree ("tenant_id","status");--> statement-breakpoint

-- Hand-added: tenancy, grants and audit (CLAUDE.md → Tenancy, Evidence and audit). The app may add and read; status
-- changes arrive with vehicle_events, each with its own grant. idempotency_keys is bookkeeping for retries, not
-- business data, so it isn't audited (and has no id for audit_row).
GRANT SELECT, INSERT ON counterparties, vehicles, idempotency_keys TO finbook_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['counterparties', 'vehicles', 'idempotency_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO finbook_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['counterparties', 'vehicles'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
  END LOOP;
END $$;
