-- The unique key the job_orders_customer FK points at must exist first (moved up by hand from drizzle's order).
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_tenant_id_id_kind" UNIQUE("tenant_id","id","kind");
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"original_filename" text NOT NULL,
	"evidence_key" text,
	"rejected_reason" text,
	"uploaded_by" text DEFAULT app_user_id() NOT NULL,
	"stored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "documents_doc_type" CHECK ("documents"."doc_type" in ('accepted_quote', 'receipt', 'invoice', 'customs', 'bill_of_lading', 'photo', 'other')),
	CONSTRAINT "documents_status" CHECK ("documents"."status" in ('pending', 'stored', 'rejected')),
	CONSTRAINT "documents_mime" CHECK ("documents"."mime" in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic')),
	CONSTRAINT "documents_size" CHECK ("documents"."size_bytes" BETWEEN 1 AND 20971520),
	CONSTRAINT "documents_sha256" CHECK ("documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "documents_stored" CHECK (("documents"."status" = 'stored') = ("documents"."evidence_key" IS NOT NULL AND "documents"."stored_at" IS NOT NULL)),
	CONSTRAINT "documents_rejected" CHECK (("documents"."status" = 'rejected') = ("documents"."rejected_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "job_order_vehicles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_order_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_order_vehicles_one_job_per_car" UNIQUE("tenant_id","vehicle_id")
);
--> statement-breakpoint
CREATE TABLE "job_orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_kind" text DEFAULT 'customer' NOT NULL,
	"job_type" text NOT NULL,
	"funding" text DEFAULT 'customer_funded' NOT NULL,
	"funding_reason" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"ordered_on" date NOT NULL,
	"car_price_minor" bigint,
	"car_price_currency" char(3),
	"quote_rate" numeric(18, 6),
	"quote_rate_source" text,
	"quote_rate_note" text,
	"landing_charge_ngn" bigint NOT NULL,
	"accepted_quote_document_id" uuid,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_orders_tenant_number" UNIQUE("tenant_id","number"),
	CONSTRAINT "job_orders_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_orders_customer_kind" CHECK ("job_orders"."customer_kind" = 'customer'),
	CONSTRAINT "job_orders_job_type" CHECK ("job_orders"."job_type" in ('car_purchase', 'clearing_only')),
	CONSTRAINT "job_orders_funding" CHECK ("job_orders"."funding" in ('customer_funded', 'emm_funded')),
	CONSTRAINT "job_orders_funding_reason" CHECK ("job_orders"."funding" = 'customer_funded' OR btrim(coalesce("job_orders"."funding_reason", '')) <> ''),
	CONSTRAINT "job_orders_status" CHECK ("job_orders"."status" in ('draft', 'quote_accepted', 'completed', 'abandoned', 'cancelled')),
	CONSTRAINT "job_orders_number" CHECK ("job_orders"."number" > 0),
	CONSTRAINT "job_orders_landing_charge" CHECK ("job_orders"."landing_charge_ngn" >= 0),
	CONSTRAINT "job_orders_quote_shape" CHECK (CASE "job_orders"."job_type"
    WHEN 'car_purchase' THEN "job_orders"."car_price_minor" > 0 AND "job_orders"."car_price_currency" IS NOT NULL AND "job_orders"."car_price_currency" <> 'NGN' AND "job_orders"."quote_rate" > 0 AND "job_orders"."quote_rate_source" IS NOT NULL
    ELSE "job_orders"."car_price_minor" IS NULL AND "job_orders"."car_price_currency" IS NULL AND "job_orders"."quote_rate" IS NULL AND "job_orders"."quote_rate_source" IS NULL END),
	CONSTRAINT "job_orders_quote_rate_source" CHECK ("job_orders"."quote_rate_source" in ('cbn', 'market', 'manual')),
	CONSTRAINT "job_orders_quote_rate_note" CHECK ("job_orders"."quote_rate_source" IS DISTINCT FROM 'manual' OR btrim(coalesce("job_orders"."quote_rate_note", '')) <> ''),
	CONSTRAINT "job_orders_accepted" CHECK (("job_orders"."accepted_quote_document_id" IS NULL) = ("job_orders"."accepted_at" IS NULL) AND ("job_orders"."status" = 'draft') = ("job_orders"."accepted_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "tenant_counters" (
	"tenant_id" uuid NOT NULL,
	"series" text NOT NULL,
	"last" integer NOT NULL,
	CONSTRAINT "tenant_counters_tenant_id_series_pk" PRIMARY KEY("tenant_id","series")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_vehicles" ADD CONSTRAINT "job_order_vehicles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_vehicles" ADD CONSTRAINT "job_order_vehicles_job" FOREIGN KEY ("tenant_id","job_order_id") REFERENCES "public"."job_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_vehicles" ADD CONSTRAINT "job_order_vehicles_vehicle" FOREIGN KEY ("tenant_id","vehicle_id") REFERENCES "public"."vehicles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_car_price_currency_currencies_code_fk" FOREIGN KEY ("car_price_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_customer" FOREIGN KEY ("tenant_id","customer_id","customer_kind") REFERENCES "public"."counterparties"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_quote_document" FOREIGN KEY ("tenant_id","accepted_quote_document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_counters" ADD CONSTRAINT "tenant_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_tenant_sha256" ON "documents" USING btree ("tenant_id","sha256");--> statement-breakpoint
CREATE INDEX "job_orders_tenant_status" ON "job_orders" USING btree ("tenant_id","status");--> statement-breakpoint

-- Hand-added (spec → Vehicle module, Document storage; CLAUDE.md → Evidence and audit, gapless numbers).
-- The app writes only the columns a user may choose; numbers, uploader and times come from the database.
GRANT SELECT ON documents, tenant_counters, job_orders, job_order_vehicles TO finbook_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) ON documents TO finbook_app;
--> statement-breakpoint
GRANT UPDATE (status, evidence_key, rejected_reason, stored_at) ON documents TO finbook_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, customer_id, job_type, funding, funding_reason, ordered_on, car_price_minor, car_price_currency,
  quote_rate, quote_rate_source, quote_rate_note, landing_charge_ngn) ON job_orders TO finbook_app;
--> statement-breakpoint
GRANT UPDATE (status, accepted_quote_document_id, accepted_at) ON job_orders TO finbook_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, job_order_id, vehicle_id) ON job_order_vehicles TO finbook_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['documents', 'tenant_counters', 'job_orders', 'job_order_vehicles'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO finbook_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['documents', 'job_orders', 'job_order_vehicles'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── Gapless numbers: one counter row per tenant and series, locked by the upsert until COMMIT. A rolled-back insert
-- rolls the counter back with it, so numbers never skip; concurrent inserts queue on the row, so they never repeat.
-- Only this trigger touches the counters (as the owner, SECURITY DEFINER): the app can read them but never move one,
-- so it can't open a gap. A BEFORE trigger fires before RLS's WITH CHECK, so it checks the tenant itself first and never
-- touches another tenant's counter.
CREATE FUNCTION number_job_order() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user <> session_user AND NEW.tenant_id IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'a job order belongs to the current tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO tenant_counters (tenant_id, series, last) VALUES (NEW.tenant_id, 'job_order', 1)
  ON CONFLICT (tenant_id, series) DO UPDATE SET last = tenant_counters.last + 1
  RETURNING last INTO NEW.number;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION number_job_order() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER job_orders_number BEFORE INSERT ON job_orders FOR EACH ROW EXECUTE FUNCTION number_job_order();
--> statement-breakpoint

-- ── The quote-day rate: a rate marked cbn or market must be that source's rate last published on or before the order
-- date, at most 7 days earlier, latest revision (as the spot check in 0005). manual needs a note (table CHECK).
CREATE FUNCTION check_job_order_quote() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE ref fx_reference_rates%ROWTYPE;
BEGIN
  IF NEW.quote_rate_source IN ('cbn', 'market') THEN
    SELECT * INTO ref FROM fx_reference_rates
     WHERE currency = NEW.car_price_currency AND source = NEW.quote_rate_source
       AND rate_date <= NEW.ordered_on AND rate_date >= NEW.ordered_on - 7
     ORDER BY rate_date DESC, revision DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no % rate for % in the 7 days up to %: enter the quote rate as manual, with a note', NEW.quote_rate_source, NEW.car_price_currency, NEW.ordered_on
        USING ERRCODE = 'check_violation';
    END IF;
    IF ref.rate <> NEW.quote_rate THEN
      RAISE EXCEPTION 'quote rate % is marked % but that rate for % on % is %', NEW.quote_rate, NEW.quote_rate_source, NEW.car_price_currency, ref.rate_date, ref.rate
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER job_orders_quote BEFORE INSERT ON job_orders FOR EACH ROW EXECUTE FUNCTION check_job_order_quote();
--> statement-breakpoint

-- ── Accepting the quote: once, from draft, with a stored accepted_quote document and at least one car. After that the
-- quote is fixed (the columns can't be updated at all) and so is the list of cars.
CREATE FUNCTION guard_job_order_update() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'quote_accepted' THEN
    IF NOT EXISTS (SELECT 1 FROM documents WHERE tenant_id = NEW.tenant_id AND id = NEW.accepted_quote_document_id
                     AND doc_type = 'accepted_quote' AND status = 'stored') THEN
      RAISE EXCEPTION 'job order %: the accepted quote must be a stored accepted_quote document', NEW.number USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM job_order_vehicles WHERE tenant_id = NEW.tenant_id AND job_order_id = NEW.id) THEN
      RAISE EXCEPTION 'job order %: add its cars before accepting the quote', NEW.number USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- ponytail: completion, abandonment and cancellation arrive with their posting endpoints, each with its own rule here
  RAISE EXCEPTION 'job order %: % → % is not an allowed change', NEW.number, OLD.status, NEW.status USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER job_orders_guard BEFORE UPDATE ON job_orders FOR EACH ROW EXECUTE FUNCTION guard_job_order_update();
--> statement-breakpoint
CREATE FUNCTION guard_job_order_vehicle() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM job_orders WHERE tenant_id = NEW.tenant_id AND id = NEW.job_order_id AND status = 'draft' FOR UPDATE) THEN
    RAISE EXCEPTION 'cars can be added to a job order only before its quote is accepted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER job_order_vehicles_guard BEFORE INSERT ON job_order_vehicles FOR EACH ROW EXECUTE FUNCTION guard_job_order_vehicle();
--> statement-breakpoint

-- ── Evidence: a pending document is checked once, becoming stored or rejected, and then never changes again.
CREATE FUNCTION guard_document_update() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('stored', 'rejected') THEN
    RAISE EXCEPTION 'document %: % → % is not allowed (evidence is never replaced; attach a new file)', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER documents_guard BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION guard_document_update();
--> statement-breakpoint
-- A download presigns whatever key the row holds, so the key must sit under this tenant's own evidence prefix.
ALTER TABLE documents ADD CONSTRAINT documents_evidence_key_tenant
  CHECK (evidence_key IS NULL OR evidence_key LIKE 'evidence/' || tenant_id::text || '/%');
--> statement-breakpoint
-- One customer's acceptance is evidence for one job order, not several.
CREATE UNIQUE INDEX job_orders_one_job_per_quote ON job_orders (tenant_id, accepted_quote_document_id) WHERE accepted_quote_document_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER job_orders_no_delete BEFORE DELETE ON job_orders FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER job_order_vehicles_no_change BEFORE UPDATE OR DELETE ON job_order_vehicles FOR EACH ROW EXECUTE FUNCTION forbid_change();
