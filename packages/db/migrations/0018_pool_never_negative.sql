-- Custom SQL migration file, put your code below! --
-- The pool (1010) never holds less than nothing (found by the reversal endpoint's tests, 2026-11-18). Pool payments and
-- settlements were already re-computed against the pool (0004, 0006), but reversing a currency purchase after its currency
-- was spent took the pool below zero: currency paid out with no source. After every entry touching 1010, each currency it
-- touched must hold zero or more, at a naira cost of zero or more, and an empty pool costs exactly nothing.
-- ponytail: chart code 1010, as 0006; an account role column fixes all of them.
CREATE FUNCTION assert_pool(e journal_entries) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT l.currency, sum(CASE WHEN l.debit_ngn > 0 THEN l.amount_minor ELSE -l.amount_minor END) AS bal, sum(l.debit_ngn - l.credit_ngn) AS cost
      FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.tenant_id = e.tenant_id AND a.code = '1010'
       AND l.currency IN (SELECT t.currency FROM journal_lines t JOIN accounts ta ON ta.id = t.account_id WHERE t.entry_id = e.id AND ta.code = '1010')
     GROUP BY l.currency
  LOOP
    IF p.bal < 0 OR p.cost < 0 OR (p.bal = 0 AND p.cost <> 0) THEN
      RAISE EXCEPTION 'entry %: the % pool would hold % (minor units) at a cost of % kobo; currency can''t leave the pool before it came in: reverse what was paid from it first',
        e.id, p.currency, p.bal, p.cost USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION assert_pool(journal_entries) FROM PUBLIC;
--> statement-breakpoint
-- Reversals (security review and ledger audit of batch 3):
--  - a correction is our accounting call (owner 2026-11-17): posted by a firm accountant or admin of this business, checked here
--    as well as by the API's guard, as a sign-off's role is (0014). A revaluation's automatic reversal is part of it (0007): exempt;
--  - never dated before what it reverses: the books on any day between would show the reverse of something that hadn't happened;
--  - a currency purchase stands while a later payment from the pool in that currency stands: those payments were costed at an
--    average that included it, so reverse them first (as invoices and their settlements, 0015);
--  - a reversal that puts job costs back on a completed car posts, and is flagged cost_after_completion for a reviewer (ADR 0016:
--    the completion is reversed and redone), as a new cost would be.
CREATE FUNCTION assert_reversal(e journal_entries) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o journal_entries%ROWTYPE;
  v uuid;
BEGIN
  IF e.reverses_entry_id IS NULL OR e.source_type = 'fx_revaluation' THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM firm_access WHERE tenant_id = e.tenant_id AND clerk_user_id = e.created_by AND role IN ('firm_accountant', 'firm_admin')) THEN
    RAISE EXCEPTION 'entry %: a reversal is posted by a firm accountant or admin of this business', e.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO o FROM journal_entries WHERE tenant_id = e.tenant_id AND id = e.reverses_entry_id;
  IF e.entry_date < o.entry_date THEN
    RAISE EXCEPTION 'entry %: a reversal is dated on or after the entry it reverses (%)', e.id, to_char(o.entry_date, 'DD/MM/YYYY') USING ERRCODE = 'check_violation';
  END IF;
  IF o.source_type = 'currency_purchase' AND EXISTS (
       SELECT 1 FROM journal_lines bought JOIN accounts a ON a.id = bought.account_id AND a.code = '1010'
         JOIN journal_lines spent ON spent.tenant_id = e.tenant_id AND spent.account_id = bought.account_id AND spent.currency = bought.currency
                                 AND spent.rate_source = 'pool_average' AND spent.credit_ngn > 0
         JOIN journal_entry_hashes hs ON hs.entry_id = spent.entry_id
         JOIN journal_entry_hashes ho ON ho.entry_id = o.id
        WHERE bought.entry_id = o.id AND hs.seq > ho.seq AND entry_is_live(e.tenant_id, spent.entry_id)) THEN
    RAISE EXCEPTION 'entry %: currency from this purchase''s pool was paid out after it, at an average that included it: reverse those payments first', e.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF o.source_type <> 'job_completion' THEN
    FOR v IN
      SELECT DISTINCT l.vehicle_id FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.entry_id = e.id AND a.code = '1150' AND l.debit_ngn > 0
         AND EXISTS (SELECT 1 FROM journal_lines c JOIN journal_entries x ON x.id = c.entry_id
                      WHERE c.tenant_id = e.tenant_id AND c.vehicle_id = l.vehicle_id AND x.source_type = 'job_completion' AND entry_is_live(e.tenant_id, x.id))
    LOOP
      INSERT INTO job_order_flags (tenant_id, job_order_id, vehicle_id, entry_id, kind)
      SELECT e.tenant_id, jv.job_order_id, v, e.id, 'cost_after_completion' FROM job_order_vehicles jv WHERE jv.tenant_id = e.tenant_id AND jv.vehicle_id = v;
    END LOOP;
  END IF;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION assert_reversal(journal_entries) FROM PUBLIC;
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
  -- Whole-entry checks (0006, 0007, 0008, 0014, 0015, 0018) run here, just before the hash. As separate deferred triggers they could be
  -- fired early with SET CONSTRAINTS and then dodged by adding lines; once the hash is written, no line can be added.
  PERFORM assert_entry_shape(NEW);
  PERFORM assert_foreign_entry(NEW);
  PERFORM assert_fx_revaluation(NEW);
  PERFORM assert_inventory_entry(NEW);
  PERFORM assert_job_entry(NEW);
  PERFORM assert_pool(NEW);
  PERFORM assert_reversal(NEW);
  SELECT * INTO prev FROM journal_entry_hashes WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  INSERT INTO journal_entry_hashes (entry_id, tenant_id, seq, prev_hash, hash, payload_version)
  VALUES (NEW.id, NEW.tenant_id, coalesce(prev.seq, 0) + 1, prev.hash, journal_entry_hash(prev.hash, NEW.id, 3::smallint), 3);
  RETURN NULL;
END $$;
