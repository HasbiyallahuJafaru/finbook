-- Custom SQL migration file, put your code below! --
-- The default chart of accounts, seeded per client (spec → Accounting core), plus the accounts the posting rules use:
-- the agent accounts (1150, 2150, 4100, 4200; spec → Vehicle module, ADR 0001) and the revaluation accounts (1019, 2009;
-- ADR 0011). System accounts (is_system): the posting rules depend on them. Firm staff can rename any account and add
-- their own; codes and types never change once posted to (0003). Idempotent: an account that already exists is left alone.
-- Only the owner runs it (tenant onboarding; phase 3 adds the firm-admin endpoint that calls it).
-- ponytail: one operating-expense account (6000); firm staff add 6100-6900 per client as the spec's range allows.
CREATE FUNCTION seed_default_chart(p_tenant uuid) RETURNS void LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO accounts (tenant_id, code, name, type, is_system)
  SELECT p_tenant, c.code, c.name, c.type, c.is_system
    FROM (VALUES
      ('1000', 'Cash – NGN accounts', 'asset', true),
      ('1010', 'Cash – foreign currency accounts', 'asset', true),
      ('1019', 'Foreign cash – revaluation', 'asset', true),
      ('1100', 'Trade receivables', 'asset', true),
      ('1150', 'Recoverable job costs', 'asset', true),
      ('1200', 'Vehicle inventory – in transit', 'asset', true),
      ('1210', 'Vehicle inventory – in yard', 'asset', true),
      ('1300', 'Advances to shipping/clearing agents', 'asset', false),
      ('2000', 'Trade payables (suppliers, agents)', 'liability', true),
      ('2009', 'Foreign payables – revaluation', 'liability', true),
      ('2100', 'Customer deposits', 'liability', true),
      ('2150', 'Customer funds held', 'liability', true),
      ('2200', 'VAT payable', 'liability', false),
      ('3000', 'Owner''s capital', 'equity', false),
      ('3100', 'Retained earnings', 'equity', false),
      ('4000', 'Vehicle sales', 'income', true),
      ('4100', 'Car sourcing commission', 'income', true),
      ('4200', 'Clearing income', 'income', true),
      ('5000', 'Cost of vehicles sold', 'expense', true),
      ('6000', 'Operating expenses', 'expense', false),
      ('7000', 'Realized FX gain/loss', 'income', true),
      ('7100', 'Unrealized FX gain/loss', 'income', true)
    ) AS c (code, name, type, is_system)
   WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = p_tenant AND a.code = c.code)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION seed_default_chart(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Tenants that already exist get the chart too; every audit row names an actor, here this migration.
SELECT set_config('app.user_id', 'migration:0016_seed_default_chart', true);
--> statement-breakpoint
SELECT seed_default_chart(id) FROM tenants;
--> statement-breakpoint

-- Evidence on a journal line is one of this tenant's own documents (it was unchecked until now), and a stored one: checked
-- and in the evidence bucket, never a pending or rejected upload. A document never leaves 'stored' (0013), so checking at
-- insert can't be dodged later.
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_evidence" FOREIGN KEY ("tenant_id","evidence_document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION guard_line_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.evidence_document_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM documents WHERE tenant_id = NEW.tenant_id AND id = NEW.evidence_document_id AND status = 'stored') THEN
    RAISE EXCEPTION 'evidence must be a stored document: confirm the upload first' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_evidence_stored BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION guard_line_evidence();
--> statement-breakpoint

-- The dates a client's books take (owner 2026-11-17, security review of the postings endpoint): from its go-live date to
-- today, Lagos time. The first posting in a month opens it, so without this anyone recording could open a month before
-- go-live (the spec locks those) or in the future; the books record what happened. Earlier history comes in through the
-- phase-5 opening-balance import, dated at go-live. A month-end revaluation is exempt from the upper bound: its automatic
-- reversal is dated the 1st of the next month (0007 pins its dates). A client without a go-live date takes no postings.
-- A line's car and counterparty are this tenant's own (the definer checks read past RLS).
ALTER TABLE "tenants" ADD COLUMN "go_live_on" date;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_vehicle" FOREIGN KEY ("tenant_id","vehicle_id") REFERENCES "public"."vehicles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_counterparty" FOREIGN KEY ("tenant_id","counterparty_id") REFERENCES "public"."counterparties"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION guard_entry_date() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE live date;
BEGIN
  SELECT go_live_on INTO live FROM tenants WHERE id = NEW.tenant_id;
  IF live IS NULL THEN
    RAISE EXCEPTION 'this business has no go-live date yet: the firm sets it at onboarding' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.entry_date < live THEN
    RAISE EXCEPTION 'entry date % is before this business went live (%): earlier history comes in with the opening balances', NEW.entry_date, live
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.entry_date > (now() AT TIME ZONE 'Africa/Lagos')::date AND NEW.source_type IS DISTINCT FROM 'fx_revaluation' THEN
    RAISE EXCEPTION 'entry date % is in the future: the books record what has happened', NEW.entry_date USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_date_in_range BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION guard_entry_date();
--> statement-breakpoint

-- ── Ledger audit of the postings endpoint (0016) ──────────────────────────────────────────────────────────────────────────
CREATE TABLE "postings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"facts" jsonb NOT NULL,
	"created_by" text DEFAULT app_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "postings_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "job_order_flags" DROP CONSTRAINT "job_order_flags_kind";--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_flags" ADD CONSTRAINT "job_order_flags_kind" CHECK ("job_order_flags"."kind" in ('emm_funded', 'converted_to_stock', 'posted_before_quote', 'supplier_cost_not_covered', 'cost_after_completion', 'completion_unverified', 'cost_credited', 'negative_cut', 'funds_after_completion'));
--> statement-breakpoint
-- Each posting's facts, kept for good: journal_entries.source_id points here (an entry's hash covers source_id, so it must
-- point at something that lasts). The app inserts the type and facts; who and when are the database's.
GRANT SELECT, INSERT (tenant_id, type, facts) ON postings TO finbook_app;
--> statement-breakpoint
ALTER TABLE postings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE postings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON postings TO finbook_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE TRIGGER postings_audit AFTER INSERT ON postings FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER postings_no_change BEFORE UPDATE OR DELETE ON postings FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER postings_no_truncate BEFORE TRUNCATE ON postings FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
-- A month that never had a row can't be opened behind a locked one: the months before it are closed, reports gone out.
CREATE FUNCTION guard_new_period() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE live date;
BEGIN
  SELECT go_live_on INTO live FROM tenants WHERE id = NEW.tenant_id;
  IF NEW.ends_on < live THEN
    RAISE EXCEPTION 'period % to % is before this business went live (%): earlier history comes in with the opening balances', NEW.starts_on, NEW.ends_on, live
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM periods WHERE tenant_id = NEW.tenant_id AND status = 'locked' AND ends_on >= NEW.starts_on) THEN
    RAISE EXCEPTION 'period % to % would open behind a locked period: post the correction in an open period', NEW.starts_on, NEW.ends_on
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER periods_not_behind_a_lock BEFORE INSERT ON periods FOR EACH ROW EXECUTE FUNCTION guard_new_period();
--> statement-breakpoint
-- The seed refuses a system code that already exists with another type or a fixed currency: 2150 set up as income, say,
-- would show every customer deposit as revenue.
CREATE OR REPLACE FUNCTION seed_default_chart(p_tenant uuid) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE bad text;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS default_chart (code text, name text, type text, is_system boolean) ON COMMIT DROP;
  TRUNCATE default_chart;
  INSERT INTO default_chart VALUES
    ('1000', 'Cash – NGN accounts', 'asset', true),
    ('1010', 'Cash – foreign currency accounts', 'asset', true),
    ('1019', 'Foreign cash – revaluation', 'asset', true),
    ('1100', 'Trade receivables', 'asset', true),
    ('1150', 'Recoverable job costs', 'asset', true),
    ('1200', 'Vehicle inventory – in transit', 'asset', true),
    ('1210', 'Vehicle inventory – in yard', 'asset', true),
    ('1300', 'Advances to shipping/clearing agents', 'asset', false),
    ('2000', 'Trade payables (suppliers, agents)', 'liability', true),
    ('2009', 'Foreign payables – revaluation', 'liability', true),
    ('2100', 'Customer deposits', 'liability', true),
    ('2150', 'Customer funds held', 'liability', true),
    ('2200', 'VAT payable', 'liability', false),
    ('3000', 'Owner''s capital', 'equity', false),
    ('3100', 'Retained earnings', 'equity', false),
    ('4000', 'Vehicle sales', 'income', true),
    ('4100', 'Car sourcing commission', 'income', true),
    ('4200', 'Clearing income', 'income', true),
    ('5000', 'Cost of vehicles sold', 'expense', true),
    ('6000', 'Operating expenses', 'expense', false),
    ('7000', 'Realized FX gain/loss', 'income', true),
    ('7100', 'Unrealized FX gain/loss', 'income', true);
  SELECT a.code INTO bad FROM accounts a JOIN default_chart c ON c.code = a.code
   WHERE a.tenant_id = p_tenant AND c.is_system AND (a.type <> c.type OR a.currency IS NOT NULL) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'account % already exists with another type or a fixed currency: the posting rules need it as in the default chart', bad
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO accounts (tenant_id, code, name, type, is_system)
  SELECT p_tenant, c.code, c.name, c.type, c.is_system FROM default_chart c
   WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = p_tenant AND a.code = c.code);
END $$;
--> statement-breakpoint
-- A customer receipt after the car's completion is flagged (funds_after_completion); otherwise as in 0015.
CREATE OR REPLACE FUNCTION assert_job_entry(e journal_entries) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  pool uuid; payables uuid; costs uuid; held uuid; owed uuid; markup_acct uuid; margin_acct uuid; fx uuid;
  agent uuid[]; principal uuid[];
  v uuid;
  j job_orders%ROWTYPE;
  jv job_order_vehicles%ROWTYPE;
  reversal boolean := e.reverses_entry_id IS NOT NULL;
  completing boolean := e.source_type = 'job_completion' AND e.reverses_entry_id IS NULL;
  converting boolean := e.source_type = 'stock_conversion' AND e.reverses_entry_id IS NULL;
  converted boolean; completed boolean; done boolean;
  paid_now bigint; funds_now bigint;
  cost_ngn bigint; funds bigint; car_minor bigint; car_ngn bigint; car_cur text; n_cur int;
  selling bigint; at_quote bigint; markup bigint; fx_gap bigint; margin bigint; invoice bigint; from_funds bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id IS NOT NULL) THEN
    RETURN;
  END IF;
  SELECT id INTO pool FROM accounts WHERE tenant_id = e.tenant_id AND code = '1010';
  SELECT id INTO owed FROM accounts WHERE tenant_id = e.tenant_id AND code = '1100';
  SELECT id INTO payables FROM accounts WHERE tenant_id = e.tenant_id AND code = '2000';
  SELECT id INTO costs FROM accounts WHERE tenant_id = e.tenant_id AND code = '1150';
  SELECT id INTO held FROM accounts WHERE tenant_id = e.tenant_id AND code = '2150';
  SELECT id INTO markup_acct FROM accounts WHERE tenant_id = e.tenant_id AND code = '4100';
  SELECT id INTO margin_acct FROM accounts WHERE tenant_id = e.tenant_id AND code = '4200';
  SELECT id INTO fx FROM accounts WHERE tenant_id = e.tenant_id AND code = '7000';
  agent := ARRAY(SELECT id FROM accounts WHERE tenant_id = e.tenant_id AND code IN ('1150', '2150', '4100', '4200'));
  principal := ARRAY(SELECT id FROM accounts WHERE tenant_id = e.tenant_id AND code IN ('1200', '1210', '2100', '4000', '5000'));
  -- What a customer owes for a car (1100) is paid only up to what they owe: never below zero, per car and customer, reversals
  -- included (undo the payment before the bill). Ledger audit of 0015.
  IF EXISTS (SELECT 1 FROM journal_lines b
              WHERE b.tenant_id = e.tenant_id AND b.account_id = owed
                AND (b.vehicle_id, b.counterparty_id) IN (SELECT vehicle_id, counterparty_id FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND account_id = owed)
              GROUP BY b.vehicle_id, b.counterparty_id HAVING sum(b.debit_ngn - b.credit_ngn) < 0) THEN
    RAISE EXCEPTION 'entry %: what a customer owes for a car (1100) is paid only up to what they owe: undo a payment before the bill it paid', e.id USING ERRCODE = 'check_violation';
  END IF;
  FOR v IN SELECT DISTINCT vehicle_id FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id IS NOT NULL LOOP
    -- 1 (FOR SHARE: the job's status can't move under this entry until it commits)
    SELECT o.* INTO j FROM job_order_vehicles x JOIN job_orders o ON o.tenant_id = x.tenant_id AND o.id = x.job_order_id
     WHERE x.tenant_id = e.tenant_id AND x.vehicle_id = v FOR SHARE OF o;
    IF NOT FOUND OR (j.status = 'cancelled' AND NOT reversal) THEN
      RAISE EXCEPTION 'entry %: a car must be on a job order (not cancelled) before anything posts for it', e.id USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO jv FROM job_order_vehicles WHERE tenant_id = e.tenant_id AND vehicle_id = v;
    converted := converting OR EXISTS (
      SELECT 1 FROM journal_lines l JOIN journal_entries x ON x.tenant_id = l.tenant_id AND x.id = l.entry_id
       WHERE l.tenant_id = e.tenant_id AND l.vehicle_id = v AND x.id <> e.id AND x.source_type = 'stock_conversion'
         AND x.reverses_entry_id IS NULL AND entry_is_live(e.tenant_id, x.id));
    completed := EXISTS (
      SELECT 1 FROM journal_lines l JOIN journal_entries x ON x.tenant_id = l.tenant_id AND x.id = l.entry_id
       WHERE l.tenant_id = e.tenant_id AND l.vehicle_id = v AND x.id <> e.id AND x.source_type = 'job_completion'
         AND x.reverses_entry_id IS NULL AND entry_is_live(e.tenant_id, x.id));
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
      IF EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v
                   AND (account_id = held OR (account_id = owed AND j.funding = 'customer_funded' AND NOT converted)) AND counterparty_id IS DISTINCT FROM j.customer_id) THEN
        RAISE EXCEPTION 'entry %: customer funds held (2150), and what a customer job''s customer owes (1100), for job order % name that job''s customer', e.id, j.number USING ERRCODE = 'check_violation';
      END IF;
      -- 4
      IF completing THEN
        IF j.status = 'draft' THEN
          RAISE EXCEPTION 'entry %: job order % can''t complete before its quote is accepted: the cut is worked out from the accepted quote', e.id, j.number
            USING ERRCODE = 'check_violation';
        END IF;
        IF completed THEN
          RAISE EXCEPTION 'entry %: this car''s job is already completed: a car completes once (reverse the completion to redo it)', e.id USING ERRCODE = 'check_violation';
        END IF;
        SELECT coalesce(sum(debit_ngn - credit_ngn), 0) INTO cost_ngn FROM journal_lines
         WHERE tenant_id = e.tenant_id AND vehicle_id = v AND account_id = costs AND entry_id <> e.id;
        SELECT coalesce(sum(credit_ngn - debit_ngn), 0) INTO funds FROM journal_lines
         WHERE tenant_id = e.tenant_id AND vehicle_id = v AND account_id = held AND entry_id <> e.id;
        IF funds < 0 THEN
          RAISE EXCEPTION 'entry %: customer funds held for job order % are negative', e.id, j.number USING ERRCODE = 'check_violation';
        END IF;
        IF j.job_type = 'car_purchase' THEN
          -- the car's foreign cost, net of reversals: pool payments and supplier invoices naming it (as carCost in packages/ledger)
          -- (a currency whose payments were all reversed nets to nothing and doesn't count: ledger audit of 0015)
          SELECT count(*), min(currency), coalesce(sum(m), 0), coalesce(sum(n), 0) INTO n_cur, car_cur, car_minor, car_ngn
            FROM (SELECT currency, sum(CASE WHEN credit_ngn > 0 THEN amount_minor ELSE -amount_minor END) AS m, sum(credit_ngn - debit_ngn) AS n
                    FROM journal_lines WHERE tenant_id = e.tenant_id AND vehicle_id = v AND currency <> 'NGN'
                     AND ((account_id = pool AND rate_source IS DISTINCT FROM 'payable_average') OR (account_id = payables AND rate_source = 'agent_invoice'))
                   GROUP BY currency HAVING sum(CASE WHEN credit_ngn > 0 THEN amount_minor ELSE -amount_minor END) <> 0) c;
          IF n_cur <> 1 OR car_minor <= 0 OR car_cur IS DISTINCT FROM j.car_price_currency THEN
            RAISE EXCEPTION 'entry %: job order % completes once the car''s supplier cost is recorded, in the quote''s currency (%)', e.id, j.number, j.car_price_currency
              USING ERRCODE = 'check_violation';
          END IF;
          selling := round(jv.car_price_minor * j.quote_rate)::bigint;
          at_quote := round(car_minor * j.quote_rate)::bigint;
          markup := selling - at_quote;
          fx_gap := at_quote - car_ngn;
          margin := jv.landing_charge_ngn - (cost_ngn - car_ngn);
          invoice := selling + jv.landing_charge_ngn;
        ELSE
          markup := 0;
          fx_gap := 0;
          margin := jv.landing_charge_ngn - cost_ngn;
          invoice := jv.landing_charge_ngn;
        END IF;
        from_funds := least(funds, invoice);
        IF EXISTS (SELECT 1 FROM (VALUES (costs, cost_ngn), (held, -from_funds), (owed, from_funds - invoice), (markup_acct, markup), (margin_acct, margin), (fx, fx_gap)) want (account_id, net)
                    WHERE want.net <> coalesce((SELECT sum(credit_ngn - debit_ngn) FROM journal_lines
                                                 WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = want.account_id), 0)) THEN
          RAISE EXCEPTION 'entry %: the completion for job order % must match the car''s quote and ledger: job costs cleared %, funds held applied %, billed %, car markup %, clearing margin %, FX % (kobo, credit positive)',
            e.id, j.number, cost_ngn, from_funds, invoice - from_funds, markup, margin, fx_gap USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      -- 5
      IF j.job_type <> 'car_purchase' AND e.source_type IN ('pool_payment', 'supplier_invoice', 'supplier_settlement') THEN
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
      IF e.source_type = 'supplier_credit' THEN
        INSERT INTO job_order_flags (tenant_id, job_order_id, vehicle_id, entry_id, kind) VALUES (e.tenant_id, j.id, v, e.id, 'cost_credited');
      END IF;
      -- money in from the customer after the car's completion: it posts (it came in), but there is no completion left to
      -- release it; most likely it pays the balance owed and belongs on 1100 (receivable_receipt). Ledger audit of 0016.
      IF e.source_type = 'customer_receipt' AND completed THEN
        INSERT INTO job_order_flags (tenant_id, job_order_id, vehicle_id, entry_id, kind) VALUES (e.tenant_id, j.id, v, e.id, 'funds_after_completion');
      END IF;
      IF completing AND (markup < 0 OR margin < 0) THEN
        INSERT INTO job_order_flags (tenant_id, job_order_id, vehicle_id, entry_id, kind) VALUES (e.tenant_id, j.id, v, e.id, 'negative_cut');
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
    -- the job is completed exactly while every car on it has a completion that stands
    IF e.source_type = 'job_completion' AND j.status IN ('quote_accepted', 'completed') THEN
      done := job_cars_completed(e.tenant_id, j.id);
      IF done <> (j.status = 'completed') THEN
        UPDATE job_orders SET status = CASE WHEN done THEN 'completed' ELSE 'quote_accepted' END WHERE tenant_id = e.tenant_id AND id = j.id;
      END IF;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- Four eyes: a reviewer who handled evidence on any of the car's entries (a receipt's evidence sits on its cash line, which
-- names no car) doesn't sign off its flags. Otherwise as in 0015.
CREATE OR REPLACE FUNCTION guard_job_order_sign_off() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
    PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
    SELECT * INTO j FROM job_orders WHERE tenant_id = NEW.tenant_id AND id = f.job_order_id FOR SHARE;
    IF EXISTS (SELECT 1 FROM audit_log a WHERE a.tenant_id = NEW.tenant_id AND a.actor = NEW.signed_by AND (
                  a.entity_id IN (j.id, f.vehicle_id, j.customer_id, j.accepted_quote_document_id)
               OR (a.entity = 'job_order_vehicles' AND a.after ->> 'job_order_id' = j.id::text)
               OR (a.entity = 'documents' AND a.entity_id IN (SELECT d.evidence_document_id FROM journal_lines c JOIN journal_lines d
                     ON d.tenant_id = c.tenant_id AND d.entry_id = c.entry_id
                     WHERE c.tenant_id = NEW.tenant_id AND c.vehicle_id = f.vehicle_id AND d.evidence_document_id IS NOT NULL))))
       OR EXISTS (SELECT 1 FROM journal_entries e JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
                   WHERE e.tenant_id = NEW.tenant_id AND l.vehicle_id = f.vehicle_id AND e.created_by = NEW.signed_by) THEN
      RAISE EXCEPTION 'a flag is signed off by someone who touched nothing it is about: not the job, its cars, its customer, its quote, its evidence or any entry for the car' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
