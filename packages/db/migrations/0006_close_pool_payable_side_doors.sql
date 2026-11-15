-- Ledger-auditor pass 3 (docs/audits/2026-11-15-phase2-slice2-pass3.md): close the side doors around the pool (1010)
-- and foreign supplier payables (2000). Replaces 0005's check_foreign_account.
--  - 1010 holds foreign currency only: no NGN line can post to it (finding 1).
--  - NGN on 2000 pays only NGN owed (check_foreign_entry), so it can't "settle" a foreign invoice (finding 1).
--  - A foreign payable is created only by a supplier invoice (agent_invoice) naming the supplier and the car (3, 8b).
--  - A car paid straight from the pool can't also be invoiced (2a); the reverse was already refused in 0005.
--  - The tenant ledger lock is taken before any read, so two transactions can't each pass without the other (4).
-- ponytail: identifies the accounts by chart code (1010, 2000); add an account role column when tenants get several.
CREATE OR REPLACE FUNCTION check_foreign_account() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  code text;
  reversal boolean;
  payables uuid;
  pool uuid;
BEGIN
  SELECT a.code INTO code FROM accounts a WHERE a.id = NEW.account_id AND a.tenant_id = NEW.tenant_id;
  IF code IS DISTINCT FROM '1010' AND code IS DISTINCT FROM '2000' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
  SELECT coalesce(e.reverses_entry_id IS NOT NULL, false) INTO reversal FROM journal_entries e WHERE e.id = NEW.entry_id;
  reversal := coalesce(reversal, false); -- an entry we can't see is no reversal: every check applies
  SELECT a.id INTO payables FROM accounts a WHERE a.tenant_id = NEW.tenant_id AND a.code = '2000';
  SELECT a.id INTO pool FROM accounts a WHERE a.tenant_id = NEW.tenant_id AND a.code = '1010';

  IF code = '1010' THEN
    IF NEW.currency = 'NGN' THEN
      RAISE EXCEPTION 'the pool (1010) holds foreign currency only: an NGN line cannot post to it' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.credit_ngn > 0 AND NOT reversal THEN
      IF NEW.rate_source IS DISTINCT FROM 'pool_average' THEN
        RAISE EXCEPTION 'currency leaves the pool (1010) only at its average cost (rate source pool_average)' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.vehicle_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM journal_lines l WHERE l.account_id = payables AND l.vehicle_id = NEW.vehicle_id AND l.currency <> 'NGN'
         GROUP BY l.currency HAVING sum(CASE WHEN l.credit_ngn > 0 THEN l.amount_minor ELSE -l.amount_minor END) > 0) THEN
        RAISE EXCEPTION 'this car has an open supplier invoice: settle the invoice instead of paying from the pool again' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- 2000. NGN lines are checked per entry at commit (check_foreign_entry).
  IF NEW.currency = 'NGN' THEN
    RETURN NEW;
  END IF;
  IF NEW.credit_ngn > 0 AND NOT reversal THEN
    IF NEW.rate_source IS DISTINCT FROM 'agent_invoice' THEN
      RAISE EXCEPTION 'a foreign payable (2000) is created only by a supplier invoice (rate source agent_invoice)' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.counterparty_id IS NULL OR NEW.vehicle_id IS NULL THEN
      RAISE EXCEPTION 'a supplier invoice must name the supplier and the car' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM journal_lines l WHERE l.account_id = pool AND l.vehicle_id = NEW.vehicle_id AND l.rate_source = 'pool_average'
       GROUP BY l.currency HAVING sum(CASE WHEN l.credit_ngn > 0 THEN l.amount_minor ELSE -l.amount_minor END) > 0) THEN
      RAISE EXCEPTION 'this car was already paid straight from the pool: reverse that payment before booking an invoice for it' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.debit_ngn > 0 THEN
    IF NOT reversal AND NEW.rate_source IS DISTINCT FROM 'payable_average' THEN
      RAISE EXCEPTION 'a foreign payable (2000) is paid down only at its booked cost (rate source payable_average)' USING ERRCODE = 'check_violation';
    END IF;
    -- ponytail: per supplier and car, not per invoice (over-blocks a second invoice for the same car); add an invoice id on lines with the invoices table.
    IF reversal AND NEW.rate_source = 'agent_invoice' AND (
      SELECT coalesce(sum(CASE WHEN l.debit_ngn > 0 THEN l.amount_minor ELSE -l.amount_minor END), 0) FROM journal_lines l
       WHERE l.account_id = NEW.account_id AND l.rate_source = 'payable_average' AND l.currency = NEW.currency
         AND l.counterparty_id IS NOT DISTINCT FROM NEW.counterparty_id AND l.vehicle_id IS NOT DISTINCT FROM NEW.vehicle_id) <> 0 THEN
      RAISE EXCEPTION 'payments were made against this invoice: reverse those payments first' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- A reversal can't itself be reversed (finding 2b): that would re-post the original without the checks a new entry
-- gets (e.g. a direct pool payment after an invoice now exists). Post the original again as a new entry instead.
CREATE FUNCTION check_reversal_target() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.reverses_entry_id IS NOT NULL AND EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.reverses_entry_id AND reverses_entry_id IS NOT NULL) THEN
    RAISE EXCEPTION 'entry % is itself a reversal and cannot be reversed: post the original again as a new entry', NEW.reverses_entry_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_reversal_target BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION check_reversal_target();
--> statement-breakpoint
-- Whole-entry shape, checked at commit when all lines are in, so line order can't dodge it:
--  (a) a supplier settlement is currency leaving the pool for an invoice, nothing else: per currency and supplier the
--      payable_average debits equal the car-less pool credits, both ways (finding 2c; pass 5, finding 1), and its only
--      lines are those two plus realized FX in 7000 (no car named on the pool line, no FX gap into a car's cost:
--      pass 4 finding 2, pass 5 finding 2). Discounts and credit notes need their own entry type (owner decision);
--  (c) a car's supplier cost (pool payment or invoice naming it) goes to that car's job costs (1150) in the same entry,
--      same amount, as the posting rules do (pass 4, finding 5);
--  (d) NGN on 2000 pays only NGN owed: a non-reversal NGN line names the supplier, and no supplier's NGN balance on
--      2000 goes into debit (advances go to 1300). Read under the tenant lock (pass 4, finding 1).
-- Definer, like the other commit-time triggers: it must see the entry's lines whatever app.tenant_id is at commit
-- (security review: as invoker, clearing the setting before COMMIT made it see nothing and pass).
-- ponytail: chart codes again (1010, 1150, 2000); one account role column fixes all of them.
CREATE FUNCTION check_foreign_entry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  pool uuid;
  costs uuid;
  payables uuid;
  fx uuid;
  nobody constant uuid := '00000000-0000-0000-0000-000000000000'; -- stands in for "no counterparty" so the join can use =
BEGIN
  SELECT id INTO pool FROM accounts WHERE tenant_id = NEW.tenant_id AND code = '1010';
  SELECT id INTO costs FROM accounts WHERE tenant_id = NEW.tenant_id AND code = '1150';
  SELECT id INTO payables FROM accounts WHERE tenant_id = NEW.tenant_id AND code = '2000';
  SELECT id INTO fx FROM accounts WHERE tenant_id = NEW.tenant_id AND code = '7000';
  IF NEW.reverses_entry_id IS NULL AND EXISTS (
    SELECT 1 FROM journal_lines WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.id
       AND (rate_source = 'payable_average' OR (rate_source = 'pool_average' AND vehicle_id IS NULL))) THEN
    IF EXISTS (
      SELECT 1
        FROM (SELECT currency, coalesce(counterparty_id, nobody) AS party, sum(amount_minor) AS settled FROM journal_lines
               WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.id AND rate_source = 'payable_average' GROUP BY 1, 2) p
        FULL JOIN
             (SELECT currency, coalesce(counterparty_id, nobody) AS party, sum(amount_minor) AS spent FROM journal_lines
               WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.id AND rate_source = 'pool_average' AND vehicle_id IS NULL GROUP BY 1, 2) s
          ON s.currency = p.currency AND s.party = p.party
       WHERE p.settled IS DISTINCT FROM s.spent) THEN
      RAISE EXCEPTION 'entry %: a pool payment must name the car, or settle a supplier invoice in the same entry (same currency, supplier and amount), and an invoice is settled only from the pool', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      -- IS NOT DISTINCT FROM: a chart missing one of these accounts refuses every line instead of passing them (NULL).
      -- ponytail: the 7000 line may name any car, so per-car realized FX can be mis-tagged (totals and job profit can't);
      -- tie 7000's car to the payable lines' cars when per-car FX is reported.
      SELECT 1 FROM journal_lines WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.id AND NOT (
           (account_id IS NOT DISTINCT FROM payables AND rate_source IS NOT DISTINCT FROM 'payable_average')
        OR (account_id IS NOT DISTINCT FROM pool AND rate_source IS NOT DISTINCT FROM 'pool_average' AND vehicle_id IS NULL)
        OR (account_id IS NOT DISTINCT FROM fx AND currency = 'NGN'))) THEN
      RAISE EXCEPTION 'entry %: a supplier settlement holds only the payable (2000), the pool (1010, no car) and realized FX (7000); post anything else separately', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines l
     WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id AND l.vehicle_id IS NOT NULL
       AND (l.account_id = pool OR (l.account_id = payables AND l.rate_source = 'agent_invoice'))
     GROUP BY l.vehicle_id
    HAVING sum(l.credit_ngn - l.debit_ngn) <> coalesce((
      SELECT sum(c.debit_ngn - c.credit_ngn) FROM journal_lines c
       WHERE c.tenant_id = NEW.tenant_id AND c.entry_id = NEW.id AND c.account_id = costs AND c.vehicle_id = l.vehicle_id), 0)) THEN
    RAISE EXCEPTION 'entry %: a car''s supplier cost (pool payment or invoice) must go to that car''s job costs (1150): same car, same amount', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.id AND account_id = payables AND currency = 'NGN') THEN
    IF NEW.reverses_entry_id IS NULL AND EXISTS (
      SELECT 1 FROM journal_lines WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.id AND account_id = payables AND currency = 'NGN'
         AND counterparty_id IS NULL) THEN
      RAISE EXCEPTION 'entry %: an NGN line on payables (2000) must name the supplier', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
    IF EXISTS (
      SELECT 1 FROM journal_lines l
       WHERE l.tenant_id = NEW.tenant_id AND l.account_id = payables AND l.currency = 'NGN'
         AND l.counterparty_id IN (SELECT counterparty_id FROM journal_lines
                                    WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.id AND account_id = payables AND currency = 'NGN')
       GROUP BY l.counterparty_id HAVING sum(l.credit_ngn - l.debit_ngn) < 0) THEN
      RAISE EXCEPTION 'entry %: this pays a supplier more NGN than is owed to them on 2000 (an advance goes to 1300; a foreign invoice is settled in its currency)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_foreign_shape AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_foreign_entry();
--> statement-breakpoint
-- The rates login can't backdate when a rate was fetched (finding 6): fetched_at always takes its default.
REVOKE INSERT ON fx_reference_rates FROM finbook_rates;
--> statement-breakpoint
GRANT INSERT (rate_date, currency, rate, source, revision) ON fx_reference_rates TO finbook_rates;
