CREATE TABLE "job_order_flags" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_order_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_order_flags_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_order_flags_one_per_entry" UNIQUE("tenant_id","entry_id","vehicle_id","kind"),
	CONSTRAINT "job_order_flags_kind" CHECK ("job_order_flags"."kind" in ('emm_funded', 'converted_to_stock', 'posted_before_quote', 'supplier_cost_not_covered', 'cost_after_completion', 'completion_unverified', 'cost_credited'))
);
--> statement-breakpoint
CREATE TABLE "job_order_sign_offs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"flag_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"signed_by" text DEFAULT app_user_id() NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_order_sign_offs_one_per_flag" UNIQUE("tenant_id","flag_id"),
	CONSTRAINT "job_order_sign_offs_reason" CHECK (btrim("job_order_sign_offs"."reason") <> '')
);
--> statement-breakpoint
ALTER TABLE "job_order_vehicles" ADD COLUMN "car_price_minor" bigint;--> statement-breakpoint
ALTER TABLE "job_order_flags" ADD CONSTRAINT "job_order_flags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The unique key the flag FK points at must exist first (moved up by hand from drizzle's order, as in 0013).
ALTER TABLE "job_order_vehicles" ADD CONSTRAINT "job_order_vehicles_job_car" UNIQUE("tenant_id","job_order_id","vehicle_id");--> statement-breakpoint
ALTER TABLE "job_order_flags" ADD CONSTRAINT "job_order_flags_job_car" FOREIGN KEY ("tenant_id","job_order_id","vehicle_id") REFERENCES "public"."job_order_vehicles"("tenant_id","job_order_id","vehicle_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_flags" ADD CONSTRAINT "job_order_flags_entry" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_sign_offs" ADD CONSTRAINT "job_order_sign_offs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_sign_offs" ADD CONSTRAINT "job_order_sign_offs_flag" FOREIGN KEY ("tenant_id","flag_id") REFERENCES "public"."job_order_flags"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_order_flags_tenant_job" ON "job_order_flags" USING btree ("tenant_id","job_order_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_actor" ON "audit_log" USING btree ("tenant_id","actor");--> statement-breakpoint
ALTER TABLE "job_order_vehicles" ADD CONSTRAINT "job_order_vehicles_car_price" CHECK ("job_order_vehicles"."car_price_minor" > 0);--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_emm_funded_is_purchase" CHECK ("job_orders"."funding" = 'customer_funded' OR "job_orders"."job_type" = 'car_purchase');
--> statement-breakpoint

-- Hand-added: the ledger side of job orders (spec → Vehicle module; ADR 0012, 0015, 0016). We keep the client's books:
-- the database refuses only what would make them wrong or untraceable, and flags the rest for a firm reviewer.
-- Flags are written only by the database, as each entry commits (assert_job_entry); the app reads them. A sign-off names
-- only its flag and a reason: who signed and when come from the database.
GRANT SELECT ON job_order_flags TO finbook_app;
--> statement-breakpoint
GRANT SELECT, INSERT (tenant_id, flag_id, reason) ON job_order_sign_offs TO finbook_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_order_flags', 'job_order_sign_offs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO finbook_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_change()', t || '_no_change', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- A sign-off answers one flag. It confirms our accounting treatment of what the client recorded and never unlocks a
-- posting (owner, 2026-11-17). The signer is a firm reviewer or firm admin of this business (firm_access) who touched
-- nothing the flag is about (four eyes; security and ledger audits of 0014): not the job (created or changed it), its cars,
-- the car record, the job's customer, its quote document or any evidence on the car's entries (any audit_log row), and no
-- entry for the car. The job is held FOR SHARE while it is checked; the posting lock is taken only for the entry check, so
-- a sign-off never races a posting by the same person and a refused attempt never stalls the tenant's postings for long.
-- Only the table's owner (bundle import) and superusers skip the signer checks.
CREATE FUNCTION guard_job_order_sign_off() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE f job_order_flags%ROWTYPE; j job_orders%ROWTYPE;
BEGIN
  SELECT * INTO f FROM job_order_flags WHERE tenant_id = NEW.tenant_id AND id = NEW.flag_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key refuses it, in the same words as for any other missing flag
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
     AND current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) THEN
    IF NOT EXISTS (SELECT 1 FROM firm_access WHERE tenant_id = NEW.tenant_id AND clerk_user_id = NEW.signed_by AND role IN ('firm_reviewer', 'firm_admin')) THEN
      RAISE EXCEPTION 'only a firm reviewer or firm admin for this business can sign off a flag' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT * INTO j FROM job_orders WHERE tenant_id = NEW.tenant_id AND id = f.job_order_id FOR SHARE;
    IF EXISTS (SELECT 1 FROM audit_log a WHERE a.tenant_id = NEW.tenant_id AND a.actor = NEW.signed_by AND (
                  a.entity_id IN (j.id, f.vehicle_id, j.customer_id, j.accepted_quote_document_id)
               OR (a.entity = 'job_order_vehicles' AND a.after ->> 'job_order_id' = j.id::text)
               OR (a.entity = 'documents' AND a.entity_id IN (SELECT evidence_document_id FROM journal_lines
                     WHERE tenant_id = NEW.tenant_id AND vehicle_id = f.vehicle_id AND evidence_document_id IS NOT NULL)))) THEN
      RAISE EXCEPTION 'a flag is signed off by someone who touched nothing it is about: not the job, its cars, its customer, its quote, its evidence or any entry for the car' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
    IF EXISTS (SELECT 1 FROM journal_entries e JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
                WHERE e.tenant_id = NEW.tenant_id AND l.vehicle_id = f.vehicle_id AND e.created_by = NEW.signed_by) THEN
      RAISE EXCEPTION 'a flag is signed off by someone who touched nothing it is about: not the job, its cars, its customer, its quote, its evidence or any entry for the car' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER job_order_sign_offs_guard BEFORE INSERT ON job_order_sign_offs FOR EACH ROW EXECUTE FUNCTION guard_job_order_sign_off();
--> statement-breakpoint
-- The flags not yet signed off: the reviewer's worklist (spec → exception report), read under the reader's own RLS.
CREATE VIEW job_order_exceptions WITH (security_invoker = true) AS
SELECT f.tenant_id, f.id AS flag_id, f.job_order_id, o.number, f.vehicle_id, f.entry_id, f.kind, f.raised_at
  FROM job_order_flags f JOIN job_orders o ON o.tenant_id = f.tenant_id AND o.id = f.job_order_id
 WHERE NOT EXISTS (SELECT 1 FROM job_order_sign_offs s WHERE s.tenant_id = f.tenant_id AND s.flag_id = f.id);
--> statement-breakpoint
GRANT SELECT ON job_order_exceptions TO finbook_app;
--> statement-breakpoint

-- ── Each car on a car purchase carries its own quoted price (owner, 2026-11-17), so each car's cut is provable on its own.
-- A clearing-only job's cars carry none. Accepting the quote needs every car priced, adding up to the job's car price, and
-- the database stamps when it was accepted (the app can't backdate it; ledger audit of 0014).
GRANT INSERT (car_price_minor) ON job_order_vehicles TO finbook_app;
--> statement-breakpoint
REVOKE UPDATE (accepted_at) ON job_orders FROM finbook_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_job_order_vehicle() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE j job_orders%ROWTYPE;
BEGIN
  SELECT * INTO j FROM job_orders WHERE tenant_id = NEW.tenant_id AND id = NEW.job_order_id AND status = 'draft' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cars can be added to a job order only before its quote is accepted' USING ERRCODE = 'check_violation';
  END IF;
  IF (j.job_type = 'car_purchase') <> (NEW.car_price_minor IS NOT NULL) THEN
    RAISE EXCEPTION 'job order %: %', j.number,
      CASE WHEN j.job_type = 'car_purchase' THEN 'each car on a car purchase needs its own quoted price' ELSE 'a clearing-only job''s cars carry no car price' END
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_job_order_update() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'quote_accepted' THEN
    IF NOT EXISTS (SELECT 1 FROM documents WHERE tenant_id = NEW.tenant_id AND id = NEW.accepted_quote_document_id
                     AND doc_type = 'accepted_quote' AND status = 'stored') THEN
      RAISE EXCEPTION 'job order %: the accepted quote must be a stored accepted_quote document', NEW.number USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM job_order_vehicles WHERE tenant_id = NEW.tenant_id AND job_order_id = NEW.id) THEN
      RAISE EXCEPTION 'job order %: add its cars before accepting the quote', NEW.number USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.job_type = 'car_purchase' AND (SELECT sum(car_price_minor) FROM job_order_vehicles WHERE tenant_id = NEW.tenant_id AND job_order_id = NEW.id)
         IS DISTINCT FROM NEW.car_price_minor THEN
      RAISE EXCEPTION 'job order %: the cars'' own prices must add up to the quoted car price', NEW.number USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
       AND current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) THEN
      NEW.accepted_at := now();
    END IF;
    RETURN NEW;
  END IF;
  -- ponytail: completion, abandonment and cancellation arrive with their posting endpoints, each with its own rule here
  RAISE EXCEPTION 'job order %: % → % is not an allowed change', NEW.number, OLD.status, NEW.status USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint

-- ── What the database refuses: only what would make a client's books wrong or untraceable (owner, 2026-11-17, ADR 0016).
-- For every non-reversal entry naming a car (a reversal mirrors an entry that passed, and 0008 still guards its balances):
--  1. the car is on a job order that isn't cancelled;
--  2. funding decides the side (ADR 0001, 0012): an EMM-funded job's car takes no agent postings (1150, 2150, 4100, 4200);
--     a customer-funded job's car takes principal postings (1200, 1210, 2100, 4000, 5000) only once converted to stock.
--     Funding never changes after creation (no UPDATE grant, and guard_job_order_update refuses it);
--  3. customer funds held (2150) name the job's customer. They come in only by a receipt from one customer: cash in (1000)
--     and nothing else (a bank charge is its own entry). They leave only in the car's completion, a refund to the customer
--     in cash, or a conversion: never as income or another car's money (owner 2026-11-15: a deposit is never forfeited);
--  4. a completion is the entry that clears a car's job costs (Cr 1150) and applies its funds held or bills its customer
--     (Dr 2150, Dr 1100) or books its cut (4100, 4200). It happens once per car, after the quote is accepted, and holds
--     nothing but that car's lines: those, and FX (7000). Its job costs end at zero. The cut posts nowhere else, and
--     vehicle revenue and cost of sales (4000-4200, 5000) always name their car;
--  5. any other credit to a car's job costs is a supplier's credit note or refund: job costs down (Cr 1150), against what
--     is owed to a named supplier (Dr 2000, NGN) or cash back (Dr 1000), nothing else. 0008 keeps 1150 from going below zero;
--  6. a supplier purchase (a pool payment or supplier invoice naming the car, or settling its invoice from the pool) needs a
--     car-purchase job: a clearing-only job is the customer's own car.
-- Then the flags (owner 2026-11-17: flag, don't refuse), raised as the entry commits, under the tenant's posting lock, so
-- their order is the order things happened in. Each is tied to its entry and never changes; a sign-off answers it:
--  - emm_funded: the first posting for an EMM-funded job's car (the treatment is principal);
--  - converted_to_stock: the client converts the car to its own stock;
--  - posted_before_quote: a posting for a car whose job's quote isn't accepted yet;
--  - supplier_cost_not_covered: on an open customer-funded car purchase, an entry (a reversal too) that pays its supplier
--    (a pool payment or an invoice settled from the pool) or takes customer funds back, leaving the supplier paid more than
--    the customer's funds held: the client may be financing the car itself, which would make it EMM-funded;
--  - cost_after_completion: a cost posted for a car whose job is already completed: its cut is now understated;
--  - completion_unverified: every completion, until the completion endpoint re-performs the cut from the car's own quote
--    (ledger audit of 0014: the database can't yet tell a right cut from a typed one, so a reviewer checks each);
--  - cost_credited: a car's job costs brought down outside a completion (a supplier's credit note or refund), so a reviewer
--    checks it against the supplier's document.
-- A supplier paid after the car's completion is flagged as not covered too: the customer's funds were applied at completion.
-- ponytail: a completion's cut is not yet re-performed from the car's own quote (ADR 0016, blocker for the completion
-- endpoint). A clearing-only job with no costs at all can't complete (no 1150 to clear); allow it if one ever occurs.
CREATE FUNCTION assert_job_entry(e journal_entries) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cash uuid; pool uuid; payables uuid; costs uuid; held uuid; transit uuid; owed uuid; fx uuid;
  agent uuid[]; principal uuid[]; cut uuid[];
  v uuid;
  j job_orders%ROWTYPE;
  reversal boolean := e.reverses_entry_id IS NOT NULL;
  converting boolean; converted boolean; completing boolean; completed boolean; refunding boolean;
  paid_now bigint; funds_now bigint;
BEGIN
  IF NOT reversal AND EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND a.tenant_id = l.tenant_id
              WHERE l.tenant_id = e.tenant_id AND l.entry_id = e.id AND l.vehicle_id IS NULL AND a.code IN ('4000', '4100', '4200', '5000')) THEN
    RAISE EXCEPTION 'entry %: vehicle revenue and cost of sales (4000, 4100, 4200, 5000) always name their car', e.id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id IS NOT NULL) THEN
    RETURN;
  END IF;
  SELECT id INTO cash FROM accounts WHERE tenant_id = e.tenant_id AND code = '1000';
  SELECT id INTO pool FROM accounts WHERE tenant_id = e.tenant_id AND code = '1010';
  SELECT id INTO owed FROM accounts WHERE tenant_id = e.tenant_id AND code = '1100';
  SELECT id INTO payables FROM accounts WHERE tenant_id = e.tenant_id AND code = '2000';
  SELECT id INTO costs FROM accounts WHERE tenant_id = e.tenant_id AND code = '1150';
  SELECT id INTO held FROM accounts WHERE tenant_id = e.tenant_id AND code = '2150';
  SELECT id INTO transit FROM accounts WHERE tenant_id = e.tenant_id AND code = '1200';
  SELECT id INTO fx FROM accounts WHERE tenant_id = e.tenant_id AND code = '7000';
  agent := ARRAY(SELECT id FROM accounts WHERE tenant_id = e.tenant_id AND code IN ('1150', '2150', '4100', '4200'));
  principal := ARRAY(SELECT id FROM accounts WHERE tenant_id = e.tenant_id AND code IN ('1200', '1210', '2100', '4000', '5000'));
  cut := ARRAY(SELECT id FROM accounts WHERE tenant_id = e.tenant_id AND code IN ('4100', '4200'));
  FOR v IN SELECT DISTINCT vehicle_id FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id IS NOT NULL LOOP
    -- 1 (FOR SHARE: the job's status can't move under this entry until it commits)
    SELECT o.* INTO j FROM job_order_vehicles jv JOIN job_orders o ON o.tenant_id = jv.tenant_id AND o.id = jv.job_order_id
     WHERE jv.tenant_id = e.tenant_id AND jv.vehicle_id = v FOR SHARE OF o;
    IF NOT FOUND OR (j.status = 'cancelled' AND NOT reversal) THEN
      RAISE EXCEPTION 'entry %: a car must be on a job order (not cancelled) before anything posts for it', e.id USING ERRCODE = 'check_violation';
    END IF;
    converting := NOT reversal
              AND EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = transit AND debit_ngn > 0)
              AND EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = costs AND credit_ngn > 0);
    -- converted before: a live entry moved this car's job costs into transit (as in 0008)
    converted := converting OR EXISTS (
      SELECT 1 FROM journal_lines t JOIN journal_lines c ON c.entry_id = t.entry_id AND c.tenant_id = e.tenant_id
       WHERE t.tenant_id = e.tenant_id AND t.entry_id <> e.id AND t.vehicle_id = v AND t.account_id = transit AND t.debit_ngn > 0
         AND c.vehicle_id = v AND c.account_id = costs AND c.credit_ngn > 0 AND entry_is_live(e.tenant_id, t.entry_id));
    completing := NOT reversal AND NOT converting
              AND EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = costs AND credit_ngn > 0)
              AND EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v
                            AND ((account_id IN (held, owed) AND debit_ngn > 0) OR account_id = ANY (cut)));
    -- completed before: a live completion of this car (its job costs credited alongside funds applied, a bill or a cut)
    completed := EXISTS (
      SELECT 1 FROM journal_lines c WHERE c.tenant_id = e.tenant_id AND c.vehicle_id = v AND c.entry_id <> e.id AND c.account_id = costs AND c.credit_ngn > 0
         AND entry_is_live(e.tenant_id, c.entry_id)
         AND EXISTS (SELECT 1 FROM journal_lines m WHERE m.tenant_id = e.tenant_id AND m.entry_id = c.entry_id AND m.vehicle_id = v
                       AND ((m.account_id IN (held, owed) AND m.debit_ngn > 0) OR m.account_id = ANY (cut))));
    IF NOT reversal THEN
      -- 2
      IF j.funding = 'emm_funded' AND EXISTS (
           SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = ANY (agent)) THEN
        RAISE EXCEPTION 'entry %: job order % is EMM-funded: its car is stock (1200, 1210, 2100), never job costs or customer funds (1150, 2150, 4100, 4200)', e.id, j.number
          USING ERRCODE = 'check_violation';
      END IF;
      IF j.funding = 'customer_funded' AND NOT converted AND EXISTS (
           SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = ANY (principal)) THEN
        RAISE EXCEPTION 'entry %: job order % is customer-funded: its car is not stock unless converted to stock', e.id, j.number USING ERRCODE = 'check_violation';
      END IF;
      -- 3
      IF EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = held
                   AND counterparty_id IS DISTINCT FROM j.customer_id) THEN
        RAISE EXCEPTION 'entry %: customer funds held (2150) for job order % name that job''s customer', e.id, j.number USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = held AND credit_ngn > 0)
         AND (EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND NOT (
                 (account_id = cash AND debit_ngn > 0 AND vehicle_id IS NULL) OR (account_id = held AND credit_ngn > 0)))
           OR (SELECT count(DISTINCT counterparty_id) FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND account_id = held) > 1) THEN
        RAISE EXCEPTION 'entry %: customer funds held (2150) come in only by a receipt from one customer: cash in (1000) and nothing else in the entry', e.id
          USING ERRCODE = 'check_violation';
      END IF;
      refunding := EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = held AND debit_ngn > 0)
               AND NOT EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND NOT (
                     (account_id = held AND debit_ngn > 0) OR (account_id = cash AND credit_ngn > 0 AND vehicle_id IS NULL)));
      IF EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = held AND debit_ngn > 0)
         AND NOT (completing OR converting OR refunding) THEN
        RAISE EXCEPTION 'entry %: customer funds held (2150) leave only in the car''s completion, a refund to the customer in cash, or a conversion to stock: never as income or a cost', e.id
          USING ERRCODE = 'check_violation';
      END IF;
      -- 4
      IF EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = ANY (cut)) AND NOT completing THEN
        RAISE EXCEPTION 'entry %: car markup and clearing margin (4100, 4200) post only in the car''s completion, which clears its job costs (1150)', e.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF completing THEN
        IF j.status = 'draft' THEN
          RAISE EXCEPTION 'entry %: job order % can''t complete before its quote is accepted: the cut is worked out from the accepted quote', e.id, j.number
            USING ERRCODE = 'check_violation';
        END IF;
        IF completed THEN
          RAISE EXCEPTION 'entry %: this car''s job is already completed: a car completes once (reverse the completion to redo it)', e.id USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND (vehicle_id IS DISTINCT FROM v OR NOT (
                       (account_id = held AND debit_ngn > 0)
                    OR (account_id = owed AND debit_ngn > 0 AND counterparty_id = j.customer_id)
                    OR (account_id = costs AND credit_ngn > 0)
                    OR account_id = ANY (cut)
                    OR account_id = fx))) THEN
          RAISE EXCEPTION 'entry %: a completion holds only its car''s lines: funds held applied (2150), any balance its customer owes (1100), its job costs cleared (1150), its cut (4100, 4200) and FX (7000)', e.id
            USING ERRCODE = 'check_violation';
        END IF;
        IF (SELECT sum(debit_ngn - credit_ngn) FROM journal_lines WHERE tenant_id = e.tenant_id AND vehicle_id = v AND account_id = costs) <> 0 THEN
          RAISE EXCEPTION 'entry %: a completion clears the car''s whole job costs (1150) to zero', e.id USING ERRCODE = 'check_violation';
        END IF;
      -- 5
      ELSIF NOT converting AND EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = costs AND credit_ngn > 0)
         AND EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND NOT (
               (account_id = costs AND credit_ngn > 0 AND vehicle_id IS NOT NULL)
            OR (account_id = cash AND debit_ngn > 0 AND vehicle_id IS NULL)
            OR (account_id = payables AND debit_ngn > 0 AND currency = 'NGN' AND counterparty_id IS NOT NULL))) THEN
        RAISE EXCEPTION 'entry %: a car''s job costs (1150) come down only in its completion, a conversion, or a supplier''s credit (Dr 2000 naming the supplier, or cash back to 1000)', e.id
          USING ERRCODE = 'check_violation';
      END IF;
      -- 6
      IF j.job_type <> 'car_purchase' AND EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND (
                    (account_id = pool AND rate_source = 'pool_average' AND credit_ngn > 0)
                 OR (account_id = payables AND rate_source = 'agent_invoice' AND credit_ngn > 0)
                 OR (account_id = payables AND rate_source = 'payable_average' AND debit_ngn > 0))) THEN
        RAISE EXCEPTION 'entry %: job order % is clearing-only: the customer owns the car, so no supplier is paid for it', e.id, j.number USING ERRCODE = 'check_violation';
      END IF;
      -- flags
      -- once per car while that first posting stands: if it is reversed, the next posting raises it again (ledger audit of 0014)
      IF j.funding = 'emm_funded' AND NOT EXISTS (SELECT 1 FROM job_order_flags WHERE tenant_id = e.tenant_id AND job_order_id = j.id AND vehicle_id = v AND kind = 'emm_funded'
                                                    AND entry_id <> e.id AND entry_is_live(e.tenant_id, entry_id)) THEN
        INSERT INTO job_order_flags (tenant_id, job_order_id, vehicle_id, entry_id, kind) VALUES (e.tenant_id, j.id, v, e.id, 'emm_funded');
      END IF;
      IF converting THEN
        INSERT INTO job_order_flags (tenant_id, job_order_id, vehicle_id, entry_id, kind) VALUES (e.tenant_id, j.id, v, e.id, 'converted_to_stock');
      END IF;
      IF j.status = 'draft' THEN
        INSERT INTO job_order_flags (tenant_id, job_order_id, vehicle_id, entry_id, kind) VALUES (e.tenant_id, j.id, v, e.id, 'posted_before_quote');
      END IF;
      IF completed AND EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = costs AND debit_ngn > 0) THEN
        INSERT INTO job_order_flags (tenant_id, job_order_id, vehicle_id, entry_id, kind) VALUES (e.tenant_id, j.id, v, e.id, 'cost_after_completion');
      END IF;
      IF completing THEN
        INSERT INTO job_order_flags (tenant_id, job_order_id, vehicle_id, entry_id, kind) VALUES (e.tenant_id, j.id, v, e.id, 'completion_unverified');
      ELSIF NOT converting AND EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = costs AND credit_ngn > 0) THEN
        INSERT INTO job_order_flags (tenant_id, job_order_id, vehicle_id, entry_id, kind) VALUES (e.tenant_id, j.id, v, e.id, 'cost_credited');
      END IF;
    END IF;
    -- supplier paid beyond the customer's funds: checked on reversals too (reversing a receipt can open the gap)
    IF j.funding = 'customer_funded' AND j.job_type = 'car_purchase' AND NOT converted AND NOT completing THEN
      SELECT coalesce(sum(CASE WHEN account_id = pool THEN credit_ngn - debit_ngn ELSE debit_ngn - credit_ngn END), 0) INTO paid_now
        FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v
         AND ((account_id = pool AND rate_source = 'pool_average') OR (account_id = payables AND rate_source = 'payable_average'));
      SELECT coalesce(sum(credit_ngn - debit_ngn), 0) INTO funds_now
        FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = held;
      IF (completed AND paid_now > 0) OR ((paid_now > 0 OR funds_now < 0) AND NOT completed
         AND (SELECT coalesce(sum(CASE WHEN account_id = pool THEN credit_ngn - debit_ngn ELSE debit_ngn - credit_ngn END), 0)
                FROM journal_lines WHERE tenant_id = e.tenant_id AND vehicle_id = v
                 AND ((account_id = pool AND rate_source = 'pool_average') OR (account_id = payables AND rate_source = 'payable_average')))
           > (SELECT coalesce(sum(credit_ngn - debit_ngn), 0) FROM journal_lines WHERE tenant_id = e.tenant_id AND vehicle_id = v AND account_id = held)) THEN
        INSERT INTO job_order_flags (tenant_id, job_order_id, vehicle_id, entry_id, kind) VALUES (e.tenant_id, j.id, v, e.id, 'supplier_cost_not_covered');
      END IF;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION assert_job_entry(journal_entries) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION post_journal_entry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n int;
  dr bigint;
  cr bigint;
  prev journal_entry_hashes%ROWTYPE;
BEGIN
  -- One lock per tenant before any check, so every whole-entry check reads a settled ledger whatever accounts the entry
  -- touches (ledger audit of 0014; the same lock is taken again below, which is a no-op).
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
  -- Whole-entry checks (0006, 0007, 0008, 0014) run here, just before the hash. As separate deferred triggers they could be fired
  -- early with SET CONSTRAINTS and then dodged by adding lines; once the hash is written, no line can be added.
  PERFORM assert_foreign_entry(NEW);
  PERFORM assert_fx_revaluation(NEW);
  PERFORM assert_inventory_entry(NEW);
  PERFORM assert_job_entry(NEW);
  -- One chain per tenant: serialize this tenant's commits while we read the head and append.
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
  SELECT * INTO prev FROM journal_entry_hashes WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  INSERT INTO journal_entry_hashes (entry_id, tenant_id, seq, prev_hash, hash, payload_version)
  VALUES (NEW.id, NEW.tenant_id, coalesce(prev.seq, 0) + 1, prev.hash, journal_entry_hash(prev.hash, NEW.id, 3::smallint), 3);
  RETURN NULL;
END $$;
