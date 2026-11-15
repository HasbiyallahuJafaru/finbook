-- EMM-funded (principal) path, ADR 0012. Whole-entry checks run inside post_journal_entry (0007), so this migration
-- adds one more and redefines that function. Nobody may call the checks directly.
CREATE OR REPLACE FUNCTION assert_foreign_entry(e journal_entries) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  pool uuid;
  costs uuid;
  inventory uuid;
  payables uuid;
  fx uuid;
  nobody constant uuid := '00000000-0000-0000-0000-000000000000'; -- stands in for "no counterparty" so the join can use =
BEGIN
  SELECT id INTO pool FROM accounts WHERE tenant_id = e.tenant_id AND code = '1010';
  SELECT id INTO costs FROM accounts WHERE tenant_id = e.tenant_id AND code = '1150';
  SELECT id INTO inventory FROM accounts WHERE tenant_id = e.tenant_id AND code = '1200';
  SELECT id INTO payables FROM accounts WHERE tenant_id = e.tenant_id AND code = '2000';
  SELECT id INTO fx FROM accounts WHERE tenant_id = e.tenant_id AND code = '7000';
  IF e.reverses_entry_id IS NULL AND EXISTS (
    SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id
       AND (rate_source = 'payable_average' OR (rate_source = 'pool_average' AND vehicle_id IS NULL))) THEN
    IF EXISTS (
      SELECT 1
        FROM (SELECT currency, coalesce(counterparty_id, nobody) AS party, sum(amount_minor) AS settled FROM journal_lines
               WHERE tenant_id = e.tenant_id AND entry_id = e.id AND rate_source = 'payable_average' GROUP BY 1, 2) p
        FULL JOIN
             (SELECT currency, coalesce(counterparty_id, nobody) AS party, sum(amount_minor) AS spent FROM journal_lines
               WHERE tenant_id = e.tenant_id AND entry_id = e.id AND rate_source = 'pool_average' AND vehicle_id IS NULL GROUP BY 1, 2) s
          ON s.currency = p.currency AND s.party = p.party
       WHERE p.settled IS DISTINCT FROM s.spent) THEN
      RAISE EXCEPTION 'entry %: a pool payment must name the car, or settle a supplier invoice in the same entry (same currency, supplier and amount), and an invoice is settled only from the pool', e.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      -- IS NOT DISTINCT FROM: a chart missing one of these accounts refuses every line instead of passing them (NULL).
      -- ponytail: the 7000 line may name any car, so per-car realized FX can be mis-tagged (totals and job profit can't);
      -- tie 7000's car to the payable lines' cars when per-car FX is reported.
      SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND NOT (
           (account_id IS NOT DISTINCT FROM payables AND rate_source IS NOT DISTINCT FROM 'payable_average')
        OR (account_id IS NOT DISTINCT FROM pool AND rate_source IS NOT DISTINCT FROM 'pool_average' AND vehicle_id IS NULL)
        OR (account_id IS NOT DISTINCT FROM fx AND currency = 'NGN'))) THEN
      RAISE EXCEPTION 'entry %: a supplier settlement holds only the payable (2000), the pool (1010, no car) and realized FX (7000); post anything else separately', e.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines l
     WHERE l.tenant_id = e.tenant_id AND l.entry_id = e.id AND l.vehicle_id IS NOT NULL
       AND (l.account_id = pool OR (l.account_id = payables AND l.rate_source = 'agent_invoice'))
     GROUP BY l.vehicle_id
    HAVING sum(l.credit_ngn - l.debit_ngn) <> coalesce((
      SELECT sum(c.debit_ngn - c.credit_ngn) FROM journal_lines c
       WHERE c.tenant_id = e.tenant_id AND c.entry_id = e.id AND c.account_id IN (costs, inventory) AND c.vehicle_id = l.vehicle_id), 0)) THEN
    RAISE EXCEPTION 'entry %: a car''s supplier cost (pool payment or invoice) must go to that car''s job costs (1150), or its inventory (1200) if EMM-funded: same car, same amount', e.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND account_id = payables AND currency = 'NGN') THEN
    IF e.reverses_entry_id IS NULL AND EXISTS (
      SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND account_id = payables AND currency = 'NGN'
         AND counterparty_id IS NULL) THEN
      RAISE EXCEPTION 'entry %: an NGN line on payables (2000) must name the supplier', e.id USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || e.tenant_id::text, 0));
    IF EXISTS (
      SELECT 1 FROM journal_lines l
       WHERE l.tenant_id = e.tenant_id AND l.account_id = payables AND l.currency = 'NGN'
         AND l.counterparty_id IN (SELECT counterparty_id FROM journal_lines
                                    WHERE tenant_id = e.tenant_id AND entry_id = e.id AND account_id = payables AND currency = 'NGN')
       GROUP BY l.counterparty_id HAVING sum(l.credit_ngn - l.debit_ngn) < 0) THEN
      RAISE EXCEPTION 'entry %: this pays a supplier more NGN than is owed to them on 2000 (an advance goes to 1300; a foreign invoice is settled in its currency)', e.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN;
END $$;
--> statement-breakpoint
-- EMM-funded inventory (principal) and the line between it and customer-funded jobs (agent), ADR 0001 and ADR 0012.
-- The database can't see a job's funding until job_orders exists, so it reads each car's mode from its own ledger history:
--  agent side:     1150 job costs, 2150 customer funds held, 4100 car markup, 4200 clearing margin
--  principal side: 1200 in transit, 1210 in the yard, 2100 buyers' deposits, 4000 vehicle sales, 5000 cost of sales
-- (1000, 1010, 1100, 2000 and 7000 serve both.) Rules, for every car an entry names:
--  1. a car is one or the other: an entry can't touch both sides for it, an agent job can't take principal postings, and a
--     car with any principal history (EMM-funded, or converted) takes no agent postings. Mode is read from live entries
--     only (neither reversed nor a reversal), so a mistake corrected by reversal leaves the car as it was;
--  2. convert to stock is the one crossing: on an open agent job (never completed: no 4100/4200), it moves the whole
--     1150 to 1200 and repays the whole 2150 to cash (owner 2026-11-15: never forfeited), touching nothing else, and only
--     for a car EMM paid the supplier for (a clearing-only job is the customer's own car);
--  3. balances never cross zero, for every entry including reversals: 1150, 1200 and 1210 never below zero, 2150 and
--     each buyer's 2100 never in debit. So a correction undoes later steps first (sale, then arrival, then the cost);
--  4. every 1150, 2150, 1200, 1210 and 2100 line names its car, and every 2100 line its buyer;
--  5. inventory is paid for only from the pool (1010), payables (2000), cash (1000), the same car's job costs when it is
--     converted (1150), or transit (1200, on arrival): no "cost" conjured from income, equity or another car;
--  6. a car leaves 1200 only by moving its whole in-transit cost to 1210 (arrival), and leaves 1210 only in a sale that
--     moves its whole yard cost to 5000 with its revenue (4000) in the same entry and nothing left in transit.
-- Reversals mirror their original exactly (post_journal_entry): rules 3 and 4 apply to them, the rest don't.
-- ponytail: chart codes and one cash account (1000) again; the reviewer's approval before an EMM-funded supplier payment,
-- and funding locked at the first payment, land with job_orders (endpoints slice).
CREATE FUNCTION entry_is_live(p_tenant uuid, p_entry uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  -- Neither a reversal nor reversed: the entry still stands.
  SELECT NOT EXISTS (SELECT 1 FROM journal_entries
                      WHERE tenant_id = p_tenant AND ((id = p_entry AND reverses_entry_id IS NOT NULL) OR reverses_entry_id = p_entry))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION entry_is_live(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION assert_inventory_entry(e journal_entries) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
      -- Completed = a live entry that credits the car's 1150 without moving it to stock (a completion clears 1150 even at a
      -- zero cut, when it posts no 4100/4200 line).
      IF principal_before OR EXISTS (
           SELECT 1 FROM journal_lines c WHERE c.tenant_id = e.tenant_id AND c.vehicle_id = v AND c.entry_id <> e.id AND entry_is_live(e.tenant_id, c.entry_id)
              AND (c.account_id IN (markup, margin)
                   OR (c.account_id = costs AND c.credit_ngn > 0 AND NOT EXISTS (SELECT 1 FROM journal_lines t
                         WHERE t.tenant_id = e.tenant_id AND t.entry_id = c.entry_id AND t.vehicle_id = v AND t.account_id = transit AND t.debit_ngn > 0)))) THEN
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
REVOKE EXECUTE ON FUNCTION assert_inventory_entry(journal_entries) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION post_journal_entry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n int;
  dr bigint;
  cr bigint;
  prev journal_entry_hashes%ROWTYPE;
BEGIN
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
  -- Whole-entry checks (0006, 0007) run here, just before the hash. As separate deferred triggers they could be fired
  -- early with SET CONSTRAINTS and then dodged by adding lines; once the hash is written, no line can be added.
  PERFORM assert_foreign_entry(NEW);
  PERFORM assert_fx_revaluation(NEW);
  PERFORM assert_inventory_entry(NEW);
  -- One chain per tenant: serialize this tenant's commits while we read the head and append.
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
  SELECT * INTO prev FROM journal_entry_hashes WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  INSERT INTO journal_entry_hashes (entry_id, tenant_id, seq, prev_hash, hash, payload_version)
  VALUES (NEW.id, NEW.tenant_id, coalesce(prev.seq, 0) + 1, prev.hash, journal_entry_hash(prev.hash, NEW.id, 3::smallint), 3);
  RETURN NULL;
END $$;
