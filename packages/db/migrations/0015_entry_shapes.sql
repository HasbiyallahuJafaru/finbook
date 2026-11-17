ALTER TABLE "job_order_vehicles" ADD COLUMN "landing_charge_ngn" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "job_order_vehicles" ADD CONSTRAINT "job_order_vehicles_landing_charge" CHECK ("job_order_vehicles"."landing_charge_ngn" >= 0);--> statement-breakpoint
ALTER TABLE "job_order_flags" DROP CONSTRAINT "job_order_flags_kind";--> statement-breakpoint
ALTER TABLE "job_order_flags" ADD CONSTRAINT "job_order_flags_kind" CHECK ("job_order_flags"."kind" in ('emm_funded', 'converted_to_stock', 'posted_before_quote', 'supplier_cost_not_covered', 'cost_after_completion', 'completion_unverified', 'cost_credited', 'negative_cut'));
--> statement-breakpoint

-- Hand-added: allowed entry shapes (owner 2026-11-17, ADR 0017). Four ledger audits each found a new hand-crafted line shape
-- that slipped past checks judging free-form lines; a deny list can't be complete. So every posting rule in packages/ledger
-- is a named entry type (source_type) with one shape, below, and the database refuses any entry that doesn't fit its type.
-- A manual journal names no car and touches none of the accounts the posting rules keep (an NGN supplier bill for a general
-- expense, Dr expense / Cr 2000, is a manual journal; foreign payables come only from supplier invoices).

-- ── Each car carries its own landing charge (owner 2026-11-17), so each car's clearing margin is provable on its own.
GRANT INSERT (landing_charge_ngn) ON job_order_vehicles TO finbook_app;
--> statement-breakpoint
-- Every car on the job has a completion that still stands. Not a definer; the app can't execute it. What keeps the app from
-- completing a job is guard_job_order_update: only the owner (the ledger, inside post_journal_entry) moves that status, and
-- only to what this function says.
CREATE FUNCTION job_cars_completed(p_tenant uuid, p_job uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM job_order_vehicles jv WHERE jv.tenant_id = p_tenant AND jv.job_order_id = p_job AND NOT EXISTS (
      SELECT 1 FROM journal_lines l JOIN journal_entries x ON x.tenant_id = l.tenant_id AND x.id = l.entry_id
       WHERE l.tenant_id = p_tenant AND l.vehicle_id = jv.vehicle_id AND x.source_type = 'job_completion'
         AND x.reverses_entry_id IS NULL AND entry_is_live(p_tenant, x.id)))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION job_cars_completed(uuid, uuid) FROM PUBLIC;
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
    IF (SELECT sum(landing_charge_ngn) FROM job_order_vehicles WHERE tenant_id = NEW.tenant_id AND job_order_id = NEW.id) IS DISTINCT FROM NEW.landing_charge_ngn THEN
      RAISE EXCEPTION 'job order %: the cars'' own landing charges must add up to the job''s landing charge', NEW.number USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
       AND current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) THEN
      NEW.accepted_at := now();
    END IF;
    RETURN NEW;
  END IF;
  -- A job is completed exactly while every car on it has a completion that stands: the ledger moves it (assert_job_entry).
  -- Only the ledger (post_journal_entry, running as the owner) makes this change, and only to the status the cars' completions imply.
  -- (Nested IFs: plpgsql doesn't promise AND short-circuits.)
  IF ((OLD.status = 'quote_accepted' AND NEW.status = 'completed') OR (OLD.status = 'completed' AND NEW.status = 'quote_accepted'))
     AND NEW.accepted_quote_document_id IS NOT DISTINCT FROM OLD.accepted_quote_document_id THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
       AND current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) THEN
      RAISE EXCEPTION 'job order %: only the ledger completes a job: post each car''s completion', NEW.number USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.status = 'completed') = job_cars_completed(NEW.tenant_id, NEW.id) THEN
      RETURN NEW;
    END IF;
  END IF;
  -- ponytail: abandonment and cancellation arrive with their posting endpoints, each with its own rule here
  RAISE EXCEPTION 'job order %: % → % is not an allowed change', NEW.number, OLD.status, NEW.status USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
-- A posting now updates its job row (status) while holding the tenant's posting lock, so a sign-off takes that lock before
-- it locks the job: the other order could deadlock. Otherwise as in 0014.
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
               OR (a.entity = 'documents' AND a.entity_id IN (SELECT evidence_document_id FROM journal_lines
                     WHERE tenant_id = NEW.tenant_id AND vehicle_id = f.vehicle_id AND evidence_document_id IS NOT NULL))))
       OR EXISTS (SELECT 1 FROM journal_entries e JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
                   WHERE e.tenant_id = NEW.tenant_id AND l.vehicle_id = f.vehicle_id AND e.created_by = NEW.signed_by) THEN
      RAISE EXCEPTION 'a flag is signed off by someone who touched nothing it is about: not the job, its cars, its customer, its quote, its evidence or any entry for the car' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- ── The shapes. One row per kind of line an entry type may hold: its accounts (chart codes), side, NGN or foreign, the
-- rate sources a foreign line may carry (an NGN line carries none), whether it names a car, who it names (nobody, the
-- customer, or a supplier or agent), and how many such lines (max NULL: any number). Every line of an entry must fit one
-- slot of its type, and every slot's count must be in range. Slots of one type never overlap (they differ in account or
-- side). Owner-only reference data: the app can't read or change it; a change is a migration an auditor can read.
CREATE TABLE entry_shapes (
  source_type text NOT NULL,
  slot text NOT NULL,
  accounts text[] NOT NULL,
  side text NOT NULL CHECK (side IN ('debit', 'credit', 'either')),
  is_foreign boolean NOT NULL,
  rate_sources text[],
  names_car boolean NOT NULL,
  counterparty text NOT NULL CHECK (counterparty IN ('none', 'customer', 'supplier')),
  min_lines int NOT NULL CHECK (min_lines >= 0),
  max_lines int CHECK (max_lines >= min_lines),
  PRIMARY KEY (source_type, slot),
  CHECK (is_foreign = (rate_sources IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO entry_shapes (source_type, slot, accounts, side, is_foreign, rate_sources, names_car, counterparty, min_lines, max_lines) VALUES
  -- customer funds held (2150): in only as cash from the job's customer; out only in a completion, a cash refund or a conversion
  ('customer_receipt',     'cash',     '{1000}',      'debit',  false, NULL, false, 'none',     1, 1),
  ('customer_receipt',     'funds',    '{2150}',      'credit', false, NULL, true,  'customer', 1, 1),
  ('customer_refund',      'funds',    '{2150}',      'debit',  false, NULL, true,  'customer', 1, 1),
  ('customer_refund',      'cash',     '{1000}',      'credit', false, NULL, false, 'none',     1, 1),
  ('receivable_receipt',   'cash',     '{1000}',      'debit',  false, NULL, false, 'none',     1, 1),
  ('receivable_receipt',   'owed',     '{1100}',      'credit', false, NULL, true,  'customer', 1, 1),
  -- the foreign-currency pool (1010) and supplier payables (2000)
  ('currency_purchase',    'pool',     '{1010}',      'debit',  true,  '{bank_receipt,bdc_receipt,manual}', false, 'none', 1, 1),
  ('currency_purchase',    'cash',     '{1000}',      'credit', false, NULL, false, 'none',     1, 1),
  ('pool_payment',         'cost',     '{1150,1200}', 'debit',  false, NULL, true,  'none',     1, 1),
  ('pool_payment',         'pool',     '{1010}',      'credit', true,  '{pool_average}', true, 'none', 1, 1),
  ('supplier_invoice',     'cost',     '{1150,1200}', 'debit',  false, NULL, true,  'none',     1, 1),
  ('supplier_invoice',     'payable',  '{2000}',      'credit', true,  '{agent_invoice}', true, 'supplier', 1, 1),
  ('supplier_settlement',  'payable',  '{2000}',      'debit',  true,  '{payable_average}', true, 'supplier', 1, 1),
  ('supplier_settlement',  'pool',     '{1010}',      'credit', true,  '{pool_average}', false, 'supplier', 1, 1),
  ('supplier_settlement',  'fx',       '{7000}',      'either', false, NULL, true,  'none',     0, 1),
  -- NGN costs for one or more cars, split in kobo (the only type that names several cars)
  ('car_cost',             'cost',     '{1150,1200}', 'debit',  false, NULL, true,  'none',     1, NULL),
  ('car_cost',             'cash',     '{1000}',      'credit', false, NULL, false, 'none',     1, 1),
  -- a supplier's credit note or refund on a customer job: off what is owed to that supplier for that car, or cash back
  ('supplier_credit',      'costs',    '{1150}',      'credit', false, NULL, true,  'none',     1, 1),
  ('supplier_credit',      'payable',  '{2000}',      'debit',  false, NULL, true,  'supplier', 0, 1),
  ('supplier_credit',      'cash',     '{1000}',      'debit',  false, NULL, false, 'none',     0, 1),
  -- a car's completion (agent): its cut is re-performed by assert_job_entry
  ('job_completion',       'funds',    '{2150}',      'debit',  false, NULL, true,  'customer', 0, 1),
  ('job_completion',       'owed',     '{1100}',      'debit',  false, NULL, true,  'customer', 0, 1),
  ('job_completion',       'costs',    '{1150}',      'credit', false, NULL, true,  'none',     1, 1),
  ('job_completion',       'markup',   '{4100}',      'either', false, NULL, true,  'none',     0, 1),
  ('job_completion',       'margin',   '{4200}',      'either', false, NULL, true,  'none',     0, 1),
  ('job_completion',       'fx',       '{7000}',      'either', false, NULL, true,  'none',     0, 1),
  -- EMM's own stock (principal)
  ('stock_deposit',        'cash',     '{1000}',      'debit',  false, NULL, false, 'none',     1, 1),
  ('stock_deposit',        'deposit',  '{2100}',      'credit', false, NULL, true,  'customer', 1, 1),
  ('stock_deposit_refund', 'deposit',  '{2100}',      'debit',  false, NULL, true,  'customer', 1, 1),
  ('stock_deposit_refund', 'cash',     '{1000}',      'credit', false, NULL, false, 'none',     1, 1),
  ('yard_arrival',         'yard',     '{1210}',      'debit',  false, NULL, true,  'none',     1, 1),
  ('yard_arrival',         'transit',  '{1200}',      'credit', false, NULL, true,  'none',     1, 1),
  ('stock_sale',           'deposit',  '{2100}',      'debit',  false, NULL, true,  'customer', 0, 1),
  ('stock_sale',           'owed',     '{1100}',      'debit',  false, NULL, true,  'customer', 0, 1),
  ('stock_sale',           'revenue',  '{4000}',      'credit', false, NULL, true,  'none',     1, 1),
  ('stock_sale',           'cost',     '{5000}',      'debit',  false, NULL, true,  'none',     1, 1),
  ('stock_sale',           'yard',     '{1210}',      'credit', false, NULL, true,  'none',     1, 1),
  ('stock_conversion',     'transit',  '{1200}',      'debit',  false, NULL, true,  'none',     1, 1),
  ('stock_conversion',     'costs',    '{1150}',      'credit', false, NULL, true,  'none',     1, 1),
  ('stock_conversion',     'funds',    '{2150}',      'debit',  false, NULL, true,  'customer', 0, 1),
  ('stock_conversion',     'cash',     '{1000}',      'credit', false, NULL, false, 'none',     0, 1),
  -- month-end revaluation (0007 re-performs it)
  ('fx_revaluation',       'pool',     '{1019}',      'either', false, NULL, false, 'none',     0, NULL),
  ('fx_revaluation',       'payables', '{2009}',      'either', false, NULL, false, 'none',     0, NULL),
  ('fx_revaluation',       'fx',       '{7100}',      'either', false, NULL, false, 'none',     0, NULL);
--> statement-breakpoint
-- Each line of an entry with the slot of its type it fits (NULL: it fits none).
CREATE FUNCTION entry_line_slots(p_tenant uuid, p_entry uuid, p_type text) RETURNS TABLE (code text, slot text)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT a.code, s.slot
    FROM journal_lines l
    JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
    LEFT JOIN counterparties c ON c.tenant_id = l.tenant_id AND c.id = l.counterparty_id
    LEFT JOIN entry_shapes s ON s.source_type = p_type
     AND a.code = ANY (s.accounts)
     AND CASE s.side WHEN 'debit' THEN l.debit_ngn > 0 WHEN 'credit' THEN l.credit_ngn > 0 ELSE true END
     AND (l.currency <> 'NGN') = s.is_foreign
     AND CASE WHEN s.rate_sources IS NULL THEN l.rate_source IS NULL ELSE coalesce(l.rate_source = ANY (s.rate_sources), false) END
     AND (l.vehicle_id IS NOT NULL) = s.names_car
     AND CASE s.counterparty WHEN 'none' THEN l.counterparty_id IS NULL
                             WHEN 'customer' THEN coalesce(c.kind = 'customer', false)
                             ELSE coalesce(c.kind IN ('supplier', 'agent'), false) END
   WHERE l.tenant_id = p_tenant AND l.entry_id = p_entry
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION entry_line_slots(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
-- A reversal keeps the type of the entry it mirrors (post_journal_entry checks the mirror). A manual journal names no car
-- and keeps off the accounts the posting rules own. Every other entry fits its type's shape, names one car (a car_cost may
-- split over several) and one counterparty.
CREATE FUNCTION assert_entry_shape(e journal_entries) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE bad record;
BEGIN
  IF e.reverses_entry_id IS NOT NULL THEN
    IF e.source_type IS DISTINCT FROM (SELECT source_type FROM journal_entries WHERE tenant_id = e.tenant_id AND id = e.reverses_entry_id) THEN
      RAISE EXCEPTION 'entry %: a reversal keeps the entry type of the entry it reverses', e.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;
  IF e.source_type = 'manual_journal' THEN
    IF EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
                WHERE l.tenant_id = e.tenant_id AND l.entry_id = e.id
                  AND (l.vehicle_id IS NOT NULL OR a.code IN ('1010', '1019', '1100', '1150', '1200', '1210', '2009', '2100', '2150', '4000', '4100', '4200', '5000', '7100')
                       OR (a.code = '2000' AND l.currency <> 'NGN'))) THEN
      RAISE EXCEPTION 'entry %: a manual journal names no car and keeps off the accounts the posting rules own (1010, 1019, 1100, 1150, 1200, 1210, 2009, 2100, 2150, 4000, 4100, 4200, 5000, 7100, and foreign lines on 2000)', e.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM entry_shapes WHERE source_type = e.source_type) THEN
    RAISE EXCEPTION 'entry %: % is not an entry type (see entry_shapes)', e.id, e.source_type USING ERRCODE = 'check_violation';
  END IF;
  SELECT code INTO bad FROM entry_line_slots(e.tenant_id, e.id, e.source_type) WHERE slot IS NULL LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'entry %: a % entry has no place for that line on %: wrong side, currency, rate source, car or counterparty (see entry_shapes)', e.id, e.source_type, bad.code
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s.slot, s.min_lines, s.max_lines INTO bad FROM entry_shapes s
   WHERE s.source_type = e.source_type
     AND (SELECT count(*) FROM entry_line_slots(e.tenant_id, e.id, e.source_type) x WHERE x.slot = s.slot) NOT BETWEEN s.min_lines AND coalesce(s.max_lines, 2147483647)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'entry %: a % entry holds % to % "%" line(s)', e.id, e.source_type, bad.min_lines, coalesce(bad.max_lines::text, 'any number of'), bad.slot
      USING ERRCODE = 'check_violation';
  END IF;
  IF e.source_type <> 'car_cost' AND (SELECT count(DISTINCT vehicle_id) FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id) > 1 THEN
    RAISE EXCEPTION 'entry %: a % entry is for one car', e.id, e.source_type USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(DISTINCT counterparty_id) FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id) > 1 THEN
    RAISE EXCEPTION 'entry %: a % entry names one counterparty', e.id, e.source_type USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION assert_entry_shape(journal_entries) FROM PUBLIC;
--> statement-breakpoint

-- ── Job entries, now judged by entry type. The shapes fix which lines each type holds, so 0014's line-pattern rules (funds
-- held in only as a receipt, out only in a completion, refund or conversion; the cut only in a completion; job costs down
-- only in a completion, conversion or supplier credit; vehicle revenue naming its car) are the shapes now. For every
-- non-reversal entry naming a car:
--  1. the car is on a job order that isn't cancelled;
--  2. funding decides the side (ADR 0001, 0012), as in 0014;
--  3. customer funds held (2150), and what the customer owes on a customer job (1100), name the job's customer; 1100 never
--     goes below zero per car and customer;
--  4. a completion happens once per car, after the quote is accepted, and the database re-performs its cut from the car's
--     own quote and ledger (ADR 0016 blocker): job costs cleared (1150) = the car's job costs; car markup (4100) = the car's
--     price at the quote rate minus its foreign cost at the quote rate; FX (7000) = that foreign cost at the quote rate minus
--     what it cost in naira; clearing margin (4200) = the car's landing charge minus its landed cost (job costs minus the
--     naira cost of the car itself); the bill (price at the quote rate plus landing charge) is paid first from funds held
--     (2150), the rest owed (1100). Half-up to the kobo, as packages/money. A clearing-only job has no price or FX;
--  5. a supplier purchase (pool payment, supplier invoice or settlement) needs a car-purchase job.
-- Then the flags, as in 0014. completion_unverified is no longer raised (every completion is re-performed); cost_credited
-- marks every supplier_credit; negative_cut marks a completion whose car markup or clearing margin is below zero (CLAUDE.md:
-- a negative cut posts and is flagged). The job moves to completed when its last car completes, and back when a completion is reversed.
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
-- 0008's inventory guards, unchanged except that a completion is now read by entry type.
CREATE OR REPLACE FUNCTION assert_inventory_entry(e journal_entries) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cash uuid; pool uuid; payables uuid;
  costs uuid; held uuid; markup uuid; margin uuid;
  transit uuid; yard uuid; deposits uuid; sales uuid; cogs uuid;
  agent uuid[];
  principal uuid[];
  v uuid;
  agent_now boolean; principal_now boolean; agent_before boolean; principal_before boolean; converted_before boolean; converting boolean;
BEGIN
  SELECT id INTO cash FROM accounts WHERE tenant_id = e.tenant_id AND code = '1000';
  SELECT id INTO pool FROM accounts WHERE tenant_id = e.tenant_id AND code = '1010';
  SELECT id INTO payables FROM accounts WHERE tenant_id = e.tenant_id AND code = '2000';
  SELECT id INTO costs FROM accounts WHERE tenant_id = e.tenant_id AND code = '1150';
  SELECT id INTO held FROM accounts WHERE tenant_id = e.tenant_id AND code = '2150';
  SELECT id INTO markup FROM accounts WHERE tenant_id = e.tenant_id AND code = '4100';
  SELECT id INTO margin FROM accounts WHERE tenant_id = e.tenant_id AND code = '4200';
  SELECT id INTO transit FROM accounts WHERE tenant_id = e.tenant_id AND code = '1200';
  SELECT id INTO yard FROM accounts WHERE tenant_id = e.tenant_id AND code = '1210';
  SELECT id INTO deposits FROM accounts WHERE tenant_id = e.tenant_id AND code = '2100';
  SELECT id INTO sales FROM accounts WHERE tenant_id = e.tenant_id AND code = '4000';
  SELECT id INTO cogs FROM accounts WHERE tenant_id = e.tenant_id AND code = '5000';
  agent := ARRAY[costs, held, markup, margin];
  principal := ARRAY[transit, yard, deposits, sales, cogs];

  IF NOT EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id
                   AND (account_id IN (transit, yard, deposits, costs, held) OR (vehicle_id IS NOT NULL AND (account_id = ANY (agent) OR account_id = ANY (principal))))) THEN
    RETURN;
  END IF;
  -- 4
  IF EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id
               AND ((account_id IN (transit, yard, deposits, costs, held) AND vehicle_id IS NULL) OR (account_id = deposits AND counterparty_id IS NULL))) THEN
    RAISE EXCEPTION 'entry %: every job-cost, funds-held and inventory line (1150, 2150, 1200, 1210) names its car, and every deposit line (2100) its car and buyer', e.id
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || e.tenant_id::text, 0));
  -- 3
  IF EXISTS (
    SELECT 1 FROM journal_lines b
     WHERE b.tenant_id = e.tenant_id AND b.account_id IN (costs, transit, yard, held)
       AND b.vehicle_id IN (SELECT vehicle_id FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND account_id IN (costs, transit, yard, held))
     GROUP BY b.vehicle_id, b.account_id
    HAVING CASE WHEN b.account_id = held THEN sum(b.credit_ngn - b.debit_ngn) ELSE sum(b.debit_ngn - b.credit_ngn) END < 0) THEN
    RAISE EXCEPTION 'entry %: a car''s job costs (1150), inventory (1200, 1210) and funds held (2150) never cross zero: undo later steps first (the sale, then the arrival, then the cost)', e.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines b
     WHERE b.tenant_id = e.tenant_id AND b.account_id = deposits
       AND (b.vehicle_id, b.counterparty_id) IN (SELECT vehicle_id, counterparty_id FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND account_id = deposits)
     GROUP BY b.vehicle_id, b.counterparty_id
    HAVING sum(b.credit_ngn - b.debit_ngn) < 0) THEN
    RAISE EXCEPTION 'entry %: a buyer''s deposit (2100) is used or repaid only up to what that buyer paid for that car', e.id USING ERRCODE = 'check_violation';
  END IF;
  IF e.reverses_entry_id IS NOT NULL THEN
    -- Undoing a convert while later stock postings for the car still stand would leave it neither job nor stock: undo
    -- those first (ledger audit of 0008, round 4). Here the convert and this reversal are already not live.
    IF EXISTS (SELECT 1 FROM journal_lines t JOIN journal_lines c ON c.entry_id = t.entry_id AND c.tenant_id = e.tenant_id
                WHERE t.tenant_id = e.tenant_id AND t.entry_id = e.reverses_entry_id AND t.account_id = transit AND t.debit_ngn > 0
                  AND c.vehicle_id = t.vehicle_id AND c.account_id = costs AND c.credit_ngn > 0
                  AND EXISTS (SELECT 1 FROM journal_lines s WHERE s.tenant_id = e.tenant_id AND s.vehicle_id = t.vehicle_id
                                AND s.account_id = ANY (principal) AND entry_is_live(e.tenant_id, s.entry_id))) THEN
      RAISE EXCEPTION 'entry %: undo the car''s later stock postings before reversing its conversion to stock', e.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;
  -- 5
  IF EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND account_id IN (transit, yard) AND debit_ngn > 0)
     AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.tenant_id = e.tenant_id AND l.entry_id = e.id AND l.credit_ngn > 0
                   AND NOT coalesce(l.account_id = ANY (ARRAY[pool, payables, cash, transit]), false)
                   -- a 1150 credit only from the car being converted in this entry, never another car's costs
                   AND NOT (l.account_id = costs AND l.vehicle_id IN (SELECT vehicle_id FROM journal_lines
                             WHERE tenant_id = e.tenant_id AND entry_id = e.id AND account_id = transit AND debit_ngn > 0))) THEN
    RAISE EXCEPTION 'entry %: inventory (1200, 1210) is paid for only from the pool (1010), payables (2000), cash (1000), the same car''s job costs when converting (1150) or transit (1200)', e.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- 1 and 2
  FOR v IN SELECT DISTINCT vehicle_id FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id IS NOT NULL
             AND (account_id = ANY (agent) OR account_id = ANY (principal)) LOOP
    agent_now := EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = ANY (agent));
    principal_now := EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = ANY (principal));
    -- A car's mode comes from live entries only: a reversed entry and its reversal never happened, so a mistake corrected
    -- by reversal (a convert, a cost posted with the wrong funding) leaves the car as it was (ledger audit of 0008).
    agent_before := EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id <> e.id AND vehicle_id = v AND account_id = ANY (agent)
                              AND entry_is_live(e.tenant_id, entry_id));
    principal_before := EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id <> e.id AND vehicle_id = v AND account_id = ANY (principal)
                                  AND entry_is_live(e.tenant_id, entry_id));
    converted_before := EXISTS (SELECT 1 FROM journal_lines t JOIN journal_lines c ON c.entry_id = t.entry_id AND c.tenant_id = e.tenant_id
                                 WHERE t.tenant_id = e.tenant_id AND t.entry_id <> e.id AND t.vehicle_id = v AND t.account_id = transit AND t.debit_ngn > 0
                                   AND c.vehicle_id = v AND c.account_id = costs AND c.credit_ngn > 0 AND entry_is_live(e.tenant_id, t.entry_id));
    converting := EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = transit AND debit_ngn > 0)
              AND EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = costs AND credit_ngn > 0);
    IF converting THEN
      -- Completed = a live job_completion naming the car (0015: by entry type, so a supplier's credit on its job costs no longer
      -- reads as a completion; ledger audit of 0015).
      IF principal_before OR EXISTS (
           SELECT 1 FROM journal_lines c JOIN journal_entries x ON x.tenant_id = c.tenant_id AND x.id = c.entry_id
            WHERE c.tenant_id = e.tenant_id AND c.vehicle_id = v AND x.source_type = 'job_completion' AND x.reverses_entry_id IS NULL
              AND entry_is_live(e.tenant_id, x.id)) THEN
        RAISE EXCEPTION 'entry %: only an open customer-funded job (never completed, not already stock) can be converted to stock', e.id USING ERRCODE = 'check_violation';
      END IF;
      -- A clearing-only job is the customer's own car: EMM never bought it, so it can't become EMM's stock.
      IF NOT EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND vehicle_id = v AND entry_is_live(e.tenant_id, entry_id)
                       AND ((account_id = pool AND rate_source = 'pool_average') OR (account_id = payables AND rate_source = 'agent_invoice'))) THEN
        RAISE EXCEPTION 'entry %: only a car EMM paid the supplier for can be converted to stock (a clearing-only job is the customer''s own car)', e.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND NOT (
              (account_id = transit AND debit_ngn > 0) OR (account_id = costs AND credit_ngn > 0) OR (account_id = held AND debit_ngn > 0)))
         -- the rest of the entry is the refund in cash, exactly the funds held: nothing diverted elsewhere
         OR EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id IS DISTINCT FROM v
                      AND NOT (account_id = cash AND credit_ngn > 0 AND vehicle_id IS NULL))
         OR coalesce((SELECT sum(credit_ngn) FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND account_id = cash), 0)
            <> coalesce((SELECT sum(debit_ngn) FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = held), 0)
         OR (SELECT sum(debit_ngn - credit_ngn) FROM journal_lines WHERE tenant_id = e.tenant_id AND vehicle_id = v AND account_id = costs) <> 0
         OR coalesce((SELECT sum(credit_ngn - debit_ngn) FROM journal_lines WHERE tenant_id = e.tenant_id AND vehicle_id = v AND account_id = held), 0) <> 0
         OR (SELECT sum(debit_ngn) FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = transit)
            <> (SELECT sum(credit_ngn) FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND vehicle_id = v AND account_id = costs) THEN
        RAISE EXCEPTION 'entry %: converting to stock moves the job''s whole cost (1150) to 1200 and repays the customer''s whole funds held (2150), nothing else', e.id
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF agent_now AND principal_now THEN
      RAISE EXCEPTION 'entry %: a car is a customer-funded job or EMM stock, never both in one entry', e.id USING ERRCODE = 'check_violation';
    ELSIF principal_now AND agent_before AND NOT converted_before THEN
      RAISE EXCEPTION 'entry %: this car is a customer-funded job: convert it to stock before posting it as EMM stock', e.id USING ERRCODE = 'check_violation';
    ELSIF agent_now AND principal_before THEN
      RAISE EXCEPTION 'entry %: this car is EMM stock (EMM-funded or converted): it takes no customer-funded postings', e.id USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  -- 6
  IF EXISTS (
    SELECT 1 FROM journal_lines l
     WHERE l.tenant_id = e.tenant_id AND l.entry_id = e.id AND l.account_id = transit AND l.credit_ngn > 0
     GROUP BY l.vehicle_id
    HAVING sum(l.credit_ngn - l.debit_ngn) <> coalesce((
             SELECT sum(y.debit_ngn - y.credit_ngn) FROM journal_lines y
              WHERE y.tenant_id = e.tenant_id AND y.entry_id = e.id AND y.account_id = yard AND y.vehicle_id = l.vehicle_id), 0)
        OR (SELECT sum(b.debit_ngn - b.credit_ngn) FROM journal_lines b
             WHERE b.tenant_id = e.tenant_id AND b.account_id = transit AND b.vehicle_id = l.vehicle_id) <> 0) THEN
    RAISE EXCEPTION 'entry %: a car leaves transit (1200) only by moving its whole cost to the yard (1210): same car, same amount', e.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines l
     WHERE l.tenant_id = e.tenant_id AND l.entry_id = e.id AND l.account_id = yard AND l.credit_ngn > 0
     GROUP BY l.vehicle_id
    HAVING sum(l.credit_ngn - l.debit_ngn) <> coalesce((
             SELECT sum(c.debit_ngn - c.credit_ngn) FROM journal_lines c
              WHERE c.tenant_id = e.tenant_id AND c.entry_id = e.id AND c.account_id = cogs AND c.vehicle_id = l.vehicle_id), 0)
        OR (SELECT sum(b.debit_ngn - b.credit_ngn) FROM journal_lines b
             WHERE b.tenant_id = e.tenant_id AND b.account_id IN (transit, yard) AND b.vehicle_id = l.vehicle_id) <> 0
        OR NOT EXISTS (SELECT 1 FROM journal_lines s
             WHERE s.tenant_id = e.tenant_id AND s.entry_id = e.id AND s.account_id = sales AND s.vehicle_id = l.vehicle_id AND s.credit_ngn > 0)) THEN
    RAISE EXCEPTION 'entry %: a car leaves the yard (1210) only when sold: its whole cost to 5000 with its revenue (4000) in the same entry, nothing left in transit', e.id
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
-- The shape is checked first, so a misfit entry is told what its type allows before any rule-specific message.
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
  -- Whole-entry checks (0006, 0007, 0008, 0014, 0015) run here, just before the hash. As separate deferred triggers they could be
  -- fired early with SET CONSTRAINTS and then dodged by adding lines; once the hash is written, no line can be added.
  PERFORM assert_entry_shape(NEW);
  PERFORM assert_foreign_entry(NEW);
  PERFORM assert_fx_revaluation(NEW);
  PERFORM assert_inventory_entry(NEW);
  PERFORM assert_job_entry(NEW);
  SELECT * INTO prev FROM journal_entry_hashes WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  INSERT INTO journal_entry_hashes (entry_id, tenant_id, seq, prev_hash, hash, payload_version)
  VALUES (NEW.id, NEW.tenant_id, coalesce(prev.seq, 0) + 1, prev.hash, journal_entry_hash(prev.hash, NEW.id, 3::smallint), 3);
  RETURN NULL;
END $$;
