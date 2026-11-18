CREATE TABLE "cost_allocations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"cost_type_id" uuid NOT NULL,
	"shipment_id" uuid,
	"basis" text NOT NULL,
	"weight_ngn" bigint,
	"share_ngn" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_allocations_entry_car" UNIQUE("tenant_id","entry_id","vehicle_id"),
	CONSTRAINT "cost_allocations_entry_position" UNIQUE("tenant_id","entry_id","position"),
	CONSTRAINT "cost_allocations_basis" CHECK ("cost_allocations"."basis" in ('per_car', 'equal', 'by_value', 'manual')),
	CONSTRAINT "cost_allocations_share" CHECK ("cost_allocations"."share_ngn" > 0),
	CONSTRAINT "cost_allocations_position" CHECK ("cost_allocations"."position" > 0),
	CONSTRAINT "cost_allocations_weight" CHECK (("cost_allocations"."basis" = 'by_value') = ("cost_allocations"."weight_ngn" IS NOT NULL) AND coalesce("cost_allocations"."weight_ngn", 1) > 0)
);
--> statement-breakpoint
CREATE TABLE "cost_types" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_basis" text NOT NULL,
	"requires_receipt" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_types_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "cost_types_tenant_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "cost_types_default_basis" CHECK ("cost_types"."default_basis" in ('per_car', 'equal', 'by_value')),
	CONSTRAINT "cost_types_name" CHECK (btrim("cost_types"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "shipment_vehicles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	"removed_reason" text,
	CONSTRAINT "shipment_vehicles_removed" CHECK (("shipment_vehicles"."removed_at" IS NULL) = ("shipment_vehicles"."removed_by" IS NULL) AND ("shipment_vehicles"."removed_at" IS NULL) = (btrim(coalesce("shipment_vehicles"."removed_reason", '')) = ''))
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"bill_of_lading" text,
	"vessel" text,
	"port" text,
	"arrived_on" date,
	"cleared_on" date,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "shipments_tenant_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "shipments_code" CHECK (btrim("shipments"."code") <> ''),
	CONSTRAINT "shipments_closed" CHECK (("shipments"."closed_at" IS NULL) = ("shipments"."closed_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "job_order_flags" DROP CONSTRAINT "job_order_flags_kind";--> statement-breakpoint
ALTER TABLE "cost_allocations" ADD CONSTRAINT "cost_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_allocations" ADD CONSTRAINT "cost_allocations_entry" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_allocations" ADD CONSTRAINT "cost_allocations_vehicle" FOREIGN KEY ("tenant_id","vehicle_id") REFERENCES "public"."vehicles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_allocations" ADD CONSTRAINT "cost_allocations_cost_type" FOREIGN KEY ("tenant_id","cost_type_id") REFERENCES "public"."cost_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_allocations" ADD CONSTRAINT "cost_allocations_shipment" FOREIGN KEY ("tenant_id","shipment_id") REFERENCES "public"."shipments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_types" ADD CONSTRAINT "cost_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_vehicles" ADD CONSTRAINT "shipment_vehicles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_vehicles" ADD CONSTRAINT "shipment_vehicles_shipment" FOREIGN KEY ("tenant_id","shipment_id") REFERENCES "public"."shipments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_vehicles" ADD CONSTRAINT "shipment_vehicles_vehicle" FOREIGN KEY ("tenant_id","vehicle_id") REFERENCES "public"."vehicles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_allocations_tenant_vehicle" ON "cost_allocations" USING btree ("tenant_id","vehicle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_vehicles_one_per_car" ON "shipment_vehicles" USING btree ("tenant_id","vehicle_id") WHERE "shipment_vehicles"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "shipment_vehicles_tenant_shipment" ON "shipment_vehicles" USING btree ("tenant_id","shipment_id");--> statement-breakpoint
ALTER TABLE "job_order_flags" ADD CONSTRAINT "job_order_flags_kind" CHECK ("job_order_flags"."kind" in ('emm_funded', 'converted_to_stock', 'posted_before_quote', 'supplier_cost_not_covered', 'cost_after_completion', 'completion_unverified', 'cost_credited', 'negative_cut', 'funds_after_completion', 'cost_after_container_closed'));
--> statement-breakpoint
-- ── Car costs, cost types and containers (spec → landed cost; owner defaults 2026-11-17, ADR 0019) ─────────────────────────────
GRANT SELECT ON cost_types, shipments, shipment_vehicles, cost_allocations TO finbook_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, name, default_basis, requires_receipt, sort) ON cost_types TO finbook_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, code, bill_of_lading, vessel, port, arrived_on, cleared_on) ON shipments TO finbook_app;
--> statement-breakpoint
GRANT UPDATE (closed_at, closed_by) ON shipments TO finbook_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, shipment_id, vehicle_id) ON shipment_vehicles TO finbook_app;
--> statement-breakpoint
GRANT UPDATE (removed_reason) ON shipment_vehicles TO finbook_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, entry_id, position, vehicle_id, cost_type_id, shipment_id, basis, weight_ngn, share_ngn) ON cost_allocations TO finbook_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cost_types', 'shipments', 'shipment_vehicles', 'cost_allocations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO finbook_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_change()', t || '_no_truncate', t);
  END LOOP;
  -- nothing here is deleted, and only a container's closing ever changes a row
  FOREACH t IN ARRAY ARRAY['cost_types', 'cost_allocations'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_change()', t || '_no_change', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER shipments_no_delete BEFORE DELETE ON shipments FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER shipment_vehicles_no_delete BEFORE DELETE ON shipment_vehicles FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
-- A car put in the wrong container is taken out (ledger audit of 0019: a wrong classification is corrected, not left standing):
-- once, with a reason, who and when from the database, while the container is open and no standing cost of it is split onto
-- the car (reverse that cost first). The row stays, so the membership history is kept.
CREATE FUNCTION guard_shipment_vehicle_removal() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || OLD.tenant_id::text, 0));
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'that car is already out of this container' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM shipments WHERE tenant_id = OLD.tenant_id AND id = OLD.shipment_id AND closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'that container is closed for good: its cars stay as they are' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM cost_allocations c JOIN journal_entries x ON x.tenant_id = c.tenant_id AND x.id = c.entry_id
              WHERE c.tenant_id = OLD.tenant_id AND c.shipment_id = OLD.shipment_id AND c.vehicle_id = OLD.vehicle_id
                AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.tenant_id = x.tenant_id AND r.reverses_entry_id = x.id)) THEN
    RAISE EXCEPTION 'a standing cost of this container is split onto that car: reverse it first' USING ERRCODE = 'check_violation';
  END IF;
  NEW.removed_at := now();
  NEW.removed_by := app_user_id();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER shipment_vehicles_removal BEFORE UPDATE ON shipment_vehicles FOR EACH ROW EXECUTE FUNCTION guard_shipment_vehicle_removal();
--> statement-breakpoint
-- A container closes once, for good (owner default): who and when come from the database; no car or cost joins it after.
CREATE FUNCTION guard_shipment_close() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'container % is closed for good', OLD.code USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
  NEW.closed_at := now();
  NEW.closed_by := app_user_id();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER shipments_close BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION guard_shipment_close();
--> statement-breakpoint
-- The tenant's posting lock first (security review of 0019): a car joining a container never interleaves with its closing
-- (which takes the same lock in the API) or with a container cost being split across its cars.
CREATE FUNCTION guard_shipment_vehicle() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
  IF EXISTS (SELECT 1 FROM shipments WHERE tenant_id = NEW.tenant_id AND id = NEW.shipment_id AND closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'that container is closed for good: no car joins it' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER shipment_vehicles_guard BEFORE INSERT ON shipment_vehicles FOR EACH ROW EXECUTE FUNCTION guard_shipment_vehicle();
--> statement-breakpoint
-- A split is written with its own car cost, before that entry is sealed (hashed), and only for a car cost: never added to an
-- entry later, or to another kind of entry.
CREATE FUNCTION guard_cost_allocation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.entry_id AND e.source_type = 'car_cost' AND e.reverses_entry_id IS NULL
                   AND NOT EXISTS (SELECT 1 FROM journal_entry_hashes h WHERE h.entry_id = e.id)) THEN
    RAISE EXCEPTION 'a cost split is written with its own car cost, as it posts' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION guard_cost_allocation() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER cost_allocations_guard BEFORE INSERT ON cost_allocations FOR EACH ROW EXECUTE FUNCTION guard_cost_allocation();
--> statement-breakpoint
-- The spec's capitalized naira cost types (landed cost components) for each client, with their default split. The car price is
-- never a cost type (it is the supplier payment), nor is the China-side extra (RMB, paid from the pool). Idempotent; owner-run
-- at onboarding, as seed_default_chart.
CREATE FUNCTION seed_default_cost_types(p_tenant uuid) RETURNS void LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO cost_types (tenant_id, name, default_basis, requires_receipt, sort)
  SELECT p_tenant, c.name, c.basis, c.receipt, c.sort
    FROM (VALUES
      ('IDEC bill', 'per_car', false, 10), ('NCS FOB levy', 'per_car', false, 20), ('Form M', 'equal', false, 30), ('PAAR', 'equal', false, 40),
      ('ETLS levy', 'equal', false, 50), ('Shipping company fee', 'equal', false, 60), ('AMP terminal fee', 'equal', false, 70),
      ('CPC agent fee', 'equal', false, 80), ('CPH extra fee', 'per_car', true, 90), ('Transport out of Apapa', 'equal', false, 100),
      ('Transport to Abuja', 'equal', false, 110), ('Repairs, labour, boosting', 'per_car', false, 120)
    ) AS c (name, basis, receipt, sort)
   WHERE NOT EXISTS (SELECT 1 FROM cost_types t WHERE t.tenant_id = p_tenant AND t.name = c.name)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION seed_default_cost_types(uuid) FROM PUBLIC;
--> statement-breakpoint
SELECT set_config('app.user_id', 'migration:0019_costs_and_shipments', true);
--> statement-breakpoint
SELECT seed_default_cost_types(id) FROM tenants;
--> statement-breakpoint
-- Every car cost carries its cost type and its split, and the database re-performs the split (ADR 0019):
--  - the split's rows are the entry's cost lines (1150 / 1200), car by car, to the kobo; one cost type, one basis, one container or none;
--  - per_car names one car; equal and by_value are re-worked here (share = total x weight / total weight, rounded down, the
--    remainder on position 1; equal weighs each car 1), and by_value's weight is the car's supplier cost in NGN at pool cost,
--    from its ledger (as packages/ledger carCost); manual shares stand as typed, adding up by the line check;
--  - a container's equal or by-value cost is split across exactly its cars, a manual one across any of them; a cost for a
--    closed container posts and is flagged cost_after_container_closed for a reviewer (a late bill is real: record, then flag);
--  - a cost type that needs a receipt has its document on the entry (owner default: otherwise evidence may be pending).
-- A reversal mirrors its original and needs no split of its own.
CREATE FUNCTION assert_car_cost(e journal_entries) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  k record;
  weights numeric;
  n int;
BEGIN
  IF e.source_type <> 'car_cost' OR e.reverses_entry_id IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT count(*) AS n, count(DISTINCT cost_type_id) AS types, count(DISTINCT basis) AS bases, count(DISTINCT shipment_id) AS shipments,
         count(*) FILTER (WHERE shipment_id IS NULL) AS loose, min(cost_type_id::text)::uuid AS cost_type, min(shipment_id::text)::uuid AS shipment,
         min(basis) AS basis, max(position) AS last, sum(share_ngn)::numeric AS total
    INTO k FROM cost_allocations WHERE tenant_id = e.tenant_id AND entry_id = e.id;
  IF k.n = 0 THEN
    RAISE EXCEPTION 'entry %: a car cost carries its cost type and its split across the cars', e.id USING ERRCODE = 'check_violation';
  END IF;
  IF k.types <> 1 OR k.bases <> 1 OR k.shipments > 1 OR (k.shipments = 1 AND k.loose > 0) OR k.last <> k.n THEN
    RAISE EXCEPTION 'entry %: a car cost has one cost type, one split basis, one container or none, and its cars numbered from 1', e.id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    (SELECT l.vehicle_id, l.debit_ngn FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = e.id AND a.code IN ('1150', '1200')
     EXCEPT ALL SELECT vehicle_id, share_ngn FROM cost_allocations WHERE tenant_id = e.tenant_id AND entry_id = e.id)
    UNION ALL
    (SELECT vehicle_id, share_ngn FROM cost_allocations WHERE tenant_id = e.tenant_id AND entry_id = e.id
     EXCEPT ALL SELECT l.vehicle_id, l.debit_ngn FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = e.id AND a.code IN ('1150', '1200'))) THEN
    RAISE EXCEPTION 'entry %: the split must be the entry''s own cost lines, car by car, to the kobo', e.id USING ERRCODE = 'check_violation';
  END IF;
  IF k.basis = 'per_car' AND k.n <> 1 THEN
    RAISE EXCEPTION 'entry %: a per-car cost names one car', e.id USING ERRCODE = 'check_violation';
  END IF;
  IF k.basis = 'by_value' AND EXISTS (
       SELECT 1 FROM cost_allocations c WHERE c.tenant_id = e.tenant_id AND c.entry_id = e.id AND c.weight_ngn IS DISTINCT FROM (
         SELECT coalesce(sum(l.credit_ngn - l.debit_ngn), 0) FROM journal_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.tenant_id = e.tenant_id AND l.vehicle_id = c.vehicle_id AND l.currency <> 'NGN'
            AND ((a.code = '1010' AND l.rate_source IS DISTINCT FROM 'payable_average') OR (a.code = '2000' AND l.rate_source = 'agent_invoice')))) THEN
    RAISE EXCEPTION 'entry %: split by value weighs each car by its supplier cost in NGN at pool cost, from its ledger', e.id USING ERRCODE = 'check_violation';
  END IF;
  IF k.basis IN ('equal', 'by_value') THEN
    SELECT sum(coalesce(weight_ngn, 1)) INTO weights FROM cost_allocations WHERE tenant_id = e.tenant_id AND entry_id = e.id;
    IF EXISTS (
         SELECT 1 FROM cost_allocations c WHERE c.tenant_id = e.tenant_id AND c.entry_id = e.id AND c.share_ngn <>
           div(k.total * coalesce(c.weight_ngn, 1), weights) + CASE WHEN c.position = 1 THEN k.total - (
             SELECT sum(div(k.total * coalesce(x.weight_ngn, 1), weights)) FROM cost_allocations x WHERE x.tenant_id = e.tenant_id AND x.entry_id = e.id) ELSE 0 END) THEN
      RAISE EXCEPTION 'entry %: the % split must be re-performable: each share is the total times its weight over the total weight, rounded down, the remainder on the first car',
        e.id, k.basis USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF k.shipment IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM shipments WHERE tenant_id = e.tenant_id AND id = k.shipment AND closed_at IS NOT NULL) THEN
      INSERT INTO job_order_flags (tenant_id, job_order_id, vehicle_id, entry_id, kind)
      SELECT e.tenant_id, jv.job_order_id, c.vehicle_id, e.id, 'cost_after_container_closed'
        FROM cost_allocations c JOIN job_order_vehicles jv ON jv.tenant_id = c.tenant_id AND jv.vehicle_id = c.vehicle_id
       WHERE c.tenant_id = e.tenant_id AND c.entry_id = e.id;
    END IF;
    IF EXISTS (SELECT vehicle_id FROM cost_allocations WHERE tenant_id = e.tenant_id AND entry_id = e.id
               EXCEPT SELECT vehicle_id FROM shipment_vehicles WHERE tenant_id = e.tenant_id AND shipment_id = k.shipment AND removed_at IS NULL) THEN
      RAISE EXCEPTION 'entry %: every car a container''s cost is split across is in that container', e.id USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO n FROM shipment_vehicles WHERE tenant_id = e.tenant_id AND shipment_id = k.shipment AND removed_at IS NULL;
    IF k.basis IN ('equal', 'by_value') AND n <> k.n THEN
      RAISE EXCEPTION 'entry %: a container''s % cost is split across all its cars (% of %): split it by hand to leave one out', e.id, k.basis, k.n, n
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (SELECT requires_receipt FROM cost_types WHERE tenant_id = e.tenant_id AND id = k.cost_type)
     AND NOT EXISTS (SELECT 1 FROM journal_lines WHERE entry_id = e.id AND evidence_document_id IS NOT NULL) THEN
    RAISE EXCEPTION 'entry %: this cost type needs its receipt before it posts', e.id USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION assert_car_cost(journal_entries) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION post_journal_entry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n int;
  dr bigint;
  cr bigint;
  prev journal_entry_hashes%ROWTYPE;
BEGIN
  -- One lock per tenant before any check, so every whole-entry check reads a settled ledger (ledger audit of 0014).
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
  SELECT count(*), coalesce(sum(debit_ngn), 0), coalesce(sum(credit_ngn), 0) INTO n, dr, cr
    FROM journal_lines WHERE entry_id = NEW.id;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal entry % has % line(s); at least 2 are required', NEW.id, n USING ERRCODE = 'check_violation';
  END IF;
  IF dr <> cr THEN
    RAISE EXCEPTION 'journal entry % does not balance: debits % kobo, credits % kobo', NEW.id, dr, cr USING ERRCODE = 'check_violation';
  END IF;
  -- A reversal must be the exact mirror of a posted entry: same lines with debit and credit swapped.
  IF NEW.reverses_entry_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM journal_entry_hashes WHERE entry_id = NEW.reverses_entry_id) THEN
      RAISE EXCEPTION 'entry % can only reverse a posted entry', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      (SELECT account_id, credit_ngn, debit_ngn, currency, amount_minor, rate, rate_source, spot_rate, spot_source, vehicle_id, counterparty_id FROM journal_lines WHERE entry_id = NEW.reverses_entry_id
       EXCEPT ALL
       SELECT account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, spot_rate, spot_source, vehicle_id, counterparty_id FROM journal_lines WHERE entry_id = NEW.id)
      UNION ALL
      (SELECT account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, spot_rate, spot_source, vehicle_id, counterparty_id FROM journal_lines WHERE entry_id = NEW.id
       EXCEPT ALL
       SELECT account_id, credit_ngn, debit_ngn, currency, amount_minor, rate, rate_source, spot_rate, spot_source, vehicle_id, counterparty_id FROM journal_lines WHERE entry_id = NEW.reverses_entry_id)
    ) THEN
      RAISE EXCEPTION 'reversal % does not mirror entry %: every line (account, amounts, currency, rate, rate source, spot rate and source, car, customer) must match with debit and credit swapped', NEW.id, NEW.reverses_entry_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Whole-entry checks (0006, 0007, 0008, 0014, 0015, 0018, 0019) run here, just before the hash. As separate deferred triggers they could be
  -- fired early with SET CONSTRAINTS and then dodged by adding lines; once the hash is written, no line can be added.
  PERFORM assert_entry_shape(NEW);
  PERFORM assert_foreign_entry(NEW);
  PERFORM assert_fx_revaluation(NEW);
  PERFORM assert_inventory_entry(NEW);
  PERFORM assert_job_entry(NEW);
  PERFORM assert_pool(NEW);
  PERFORM assert_reversal(NEW);
  PERFORM assert_car_cost(NEW);
  SELECT * INTO prev FROM journal_entry_hashes WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  INSERT INTO journal_entry_hashes (entry_id, tenant_id, seq, prev_hash, hash, payload_version)
  VALUES (NEW.id, NEW.tenant_id, coalesce(prev.seq, 0) + 1, prev.hash, journal_entry_hash(prev.hash, NEW.id, 3::smallint), 3);
  RETURN NULL;
END $$;
