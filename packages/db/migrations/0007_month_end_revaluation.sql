CREATE TABLE "fx_revaluations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"item" text NOT NULL,
	"currency" char(3) NOT NULL,
	"balance_minor" bigint NOT NULL,
	"carrying_ngn" bigint NOT NULL,
	"rate_date" date NOT NULL,
	"rate_source" text DEFAULT 'cbn' NOT NULL,
	"rate_revision" smallint NOT NULL,
	"rate" numeric(18, 6) NOT NULL,
	"closing_ngn" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_revaluations_one_per_item" UNIQUE("entry_id","item","currency"),
	CONSTRAINT "fx_revaluations_item" CHECK ("fx_revaluations"."item" in ('pool', 'payables')),
	CONSTRAINT "fx_revaluations_not_ngn" CHECK ("fx_revaluations"."currency" <> 'NGN'),
	CONSTRAINT "fx_revaluations_cbn" CHECK ("fx_revaluations"."rate_source" = 'cbn'),
	CONSTRAINT "fx_revaluations_balance" CHECK ("fx_revaluations"."balance_minor" >= 0),
	CONSTRAINT "fx_revaluations_closing" CHECK ("fx_revaluations"."closing_ngn" = round("fx_revaluations"."balance_minor" * "fx_revaluations"."rate"))
);
--> statement-breakpoint
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_entry" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_reference" FOREIGN KEY ("rate_date","currency","rate_source","rate_revision") REFERENCES "public"."fx_reference_rates"("rate_date","currency","source","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fx_revaluations_tenant_currency" ON "fx_revaluations" USING btree ("tenant_id","currency");
--> statement-breakpoint
-- Hand-added below (ADR 0011): tenancy, grants, immutability, and the database re-performing every revaluation at commit.
ALTER TABLE fx_revaluations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE fx_revaluations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON fx_revaluations TO finbook_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
GRANT SELECT ON fx_revaluations TO finbook_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, entry_id, item, currency, balance_minor, carrying_ngn, rate_date, rate_revision, rate, closing_ngn) ON fx_revaluations TO finbook_app;
--> statement-breakpoint
CREATE TRIGGER fx_revaluations_append_only BEFORE UPDATE OR DELETE ON fx_revaluations FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER fx_revaluations_no_truncate BEFORE TRUNCATE ON fx_revaluations FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER fx_revaluations_audit AFTER INSERT ON fx_revaluations FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
-- Evidence belongs to a revaluation entry that hasn't posted yet: once the entry commits, nothing can be added to it.
CREATE FUNCTION check_revaluation_row() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.entry_id AND tenant_id = NEW.tenant_id
                    AND source_type = 'fx_revaluation' AND reverses_entry_id IS NULL) THEN
    RAISE EXCEPTION 'revaluation evidence belongs to a revaluation entry (source_type fx_revaluation)' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entry_hashes WHERE entry_id = NEW.entry_id) THEN
    RAISE EXCEPTION 'entry % is already posted: its revaluation evidence cannot change', NEW.entry_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fx_revaluations_entry_open BEFORE INSERT ON fx_revaluations FOR EACH ROW EXECUTE FUNCTION check_revaluation_row();
--> statement-breakpoint
-- At commit, a revaluation entry (spec FX rule 6) is re-performed from the ledger and the stored CBN rate:
--  - dated its period's last day D, posting only to 1019, 2009 and 7100, with its reversal dated D + 1 in the same
--    transaction (the auto-reversal on day 1 of the next period; that period must exist and be open);
--  - one evidence row for every currency with a pool (1010) or foreign payables (2000) balance or a standing
--    adjustment on D, no others, each with the ledger's balance and carrying amount on D (cost or booked, plus any
--    earlier revaluation not yet reversed by D, so a second run for the same day only adds the change);
--  - each row at the latest CBN rate on or before D, at most 7 days old, latest revision;
--  - 1019 moves by the pool rows' differences and 2009 by the payables rows'; 7100 takes the rest (the entry balances).
-- Lines on 1019 or 2009 outside a revaluation (or its reversal) are refused, so those accounts only ever hold revaluation.
-- Definer with explicit tenant filters, like the other commit-time checks.
-- ponytail: chart codes again (1010, 1019, 2000, 2009, 7100); one account role column fixes all of them.
CREATE FUNCTION assert_fx_revaluation(e journal_entries) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  pool uuid;
  pool_adj uuid;
  payables uuid;
  payables_adj uuid;
  unrealized uuid;
  ends date;
  bad record;
BEGIN
  SELECT id INTO pool FROM accounts WHERE tenant_id = e.tenant_id AND code = '1010';
  SELECT id INTO pool_adj FROM accounts WHERE tenant_id = e.tenant_id AND code = '1019';
  SELECT id INTO payables FROM accounts WHERE tenant_id = e.tenant_id AND code = '2000';
  SELECT id INTO payables_adj FROM accounts WHERE tenant_id = e.tenant_id AND code = '2009';
  SELECT id INTO unrealized FROM accounts WHERE tenant_id = e.tenant_id AND code = '7100';

  -- A reversal mirrors its original exactly (post_journal_entry). A revaluation's own reversal must be dated D + 1 and
  -- commit with it (checked below), and an entry is reversed once, so no other reversal of one can exist.
  IF e.reverses_entry_id IS NOT NULL THEN
    RETURN;
  END IF;
  IF e.source_type IS DISTINCT FROM 'fx_revaluation' THEN
    IF EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND account_id IN (pool_adj, payables_adj)) THEN
      RAISE EXCEPTION 'entry %: 1019 and 2009 hold month-end revaluation only (source_type fx_revaluation)', e.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || e.tenant_id::text, 0));
  SELECT ends_on INTO ends FROM periods WHERE id = e.period_id AND tenant_id = e.tenant_id;
  IF e.entry_date IS DISTINCT FROM ends THEN
    RAISE EXCEPTION 'a revaluation is dated its period''s last day (%)', ends USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND NOT (
       account_id IS NOT DISTINCT FROM pool_adj OR account_id IS NOT DISTINCT FROM payables_adj OR account_id IS NOT DISTINCT FROM unrealized)) THEN
    RAISE EXCEPTION 'a revaluation posts only to 1019, 2009 and 7100' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE tenant_id = e.tenant_id AND reverses_entry_id = e.id AND entry_date = e.entry_date + 1) THEN
    RAISE EXCEPTION 'a revaluation posts with its reversal dated % (day 1 of the next period), in the same transaction', e.entry_date + 1
      USING ERRCODE = 'check_violation';
  END IF;

  WITH dated AS (
    SELECT l.account_id, l.currency, l.debit_ngn, l.credit_ngn, l.amount_minor FROM journal_lines l
      JOIN journal_entries je ON je.id = l.entry_id AND je.tenant_id = e.tenant_id
     WHERE l.tenant_id = e.tenant_id AND je.entry_date <= e.entry_date AND l.currency <> 'NGN'
  ), base AS (
    SELECT 'pool'::text AS item, currency, sum(CASE WHEN debit_ngn > 0 THEN amount_minor ELSE -amount_minor END) AS bal, sum(debit_ngn - credit_ngn) AS cost
      FROM dated WHERE account_id = pool GROUP BY currency
    UNION ALL
    SELECT 'payables', currency, sum(CASE WHEN credit_ngn > 0 THEN amount_minor ELSE -amount_minor END), sum(credit_ngn - debit_ngn)
      FROM dated WHERE account_id = payables GROUP BY currency
  ), standing AS (
    SELECT r.item, r.currency, sum(r.closing_ngn - r.carrying_ngn) AS amt FROM fx_revaluations r
      JOIN journal_entries je ON je.id = r.entry_id AND je.tenant_id = e.tenant_id
     WHERE r.tenant_id = e.tenant_id AND r.entry_id <> e.id AND je.entry_date <= e.entry_date
       AND NOT EXISTS (SELECT 1 FROM journal_entries x WHERE x.tenant_id = e.tenant_id AND x.reverses_entry_id = r.entry_id AND x.entry_date <= e.entry_date)
     GROUP BY r.item, r.currency
  ), expected AS (
    SELECT coalesce(b.item, s.item) AS item, coalesce(b.currency, s.currency) AS currency,
           coalesce(b.bal, 0) AS bal, coalesce(b.cost, 0) + coalesce(s.amt, 0) AS carrying
      FROM base b FULL JOIN standing s ON s.item = b.item AND s.currency = b.currency
  ), owed AS (
    SELECT * FROM expected WHERE bal <> 0 OR carrying <> 0
  ), got AS (
    SELECT item, currency, balance_minor, carrying_ngn FROM fx_revaluations WHERE tenant_id = e.tenant_id AND entry_id = e.id
  )
  SELECT coalesce(o.item, g.item) AS item, coalesce(o.currency, g.currency) AS currency, o.bal, o.carrying, g.balance_minor, g.carrying_ngn INTO bad
    FROM owed o FULL JOIN got g ON g.item = o.item AND g.currency = o.currency
   WHERE o.bal IS DISTINCT FROM g.balance_minor OR o.carrying IS DISTINCT FROM g.carrying_ngn
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'revaluation of the % % on %: the ledger has balance % carried at % kobo, the evidence says % at %',
      bad.currency, bad.item, e.entry_date, coalesce(bad.bal::text, 'none'), coalesce(bad.carrying::text, 'none'),
      coalesce(bad.balance_minor::text, 'none'), coalesce(bad.carrying_ngn::text, 'none') USING ERRCODE = 'check_violation';
  END IF;

  SELECT r.currency, r.rate_date, r.rate_revision, ref.rate_date AS ref_date, ref.revision AS ref_revision INTO bad
    FROM fx_revaluations r
    LEFT JOIN LATERAL (
      SELECT f.rate_date, f.revision, f.rate FROM fx_reference_rates f
       WHERE f.currency = r.currency AND f.source = 'cbn' AND f.rate_date <= e.entry_date AND f.rate_date >= e.entry_date - 7
       ORDER BY f.rate_date DESC, f.revision DESC LIMIT 1) ref ON true
   WHERE r.tenant_id = e.tenant_id AND r.entry_id = e.id
     AND (ref.rate IS NULL OR r.rate_date <> ref.rate_date OR r.rate_revision <> ref.revision OR r.rate <> ref.rate)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'the % closing rate must be the latest CBN rate on or before % (at most 7 days old): latest is %, revision %',
      bad.currency, e.entry_date, coalesce(bad.ref_date::text, 'none'), coalesce(bad.ref_revision::text, 'none') USING ERRCODE = 'check_violation';
  END IF;

  IF (SELECT coalesce(sum(closing_ngn - carrying_ngn), 0) FROM fx_revaluations WHERE tenant_id = e.tenant_id AND entry_id = e.id AND item = 'pool')
       <> (SELECT coalesce(sum(debit_ngn - credit_ngn), 0) FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND account_id = pool_adj)
     OR (SELECT coalesce(sum(closing_ngn - carrying_ngn), 0) FROM fx_revaluations WHERE tenant_id = e.tenant_id AND entry_id = e.id AND item = 'payables')
       <> (SELECT coalesce(sum(credit_ngn - debit_ngn), 0) FROM journal_lines WHERE tenant_id = e.tenant_id AND entry_id = e.id AND account_id = payables_adj) THEN
    RAISE EXCEPTION 'entry %: 1019 must move by the pool''s restated difference and 2009 by the payables''', e.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN;
END $$;
--> statement-breakpoint
-- Security review of 0007, finding 1: the whole-entry checks move inside post_journal_entry (the hash-writing trigger),
-- replacing 0006's separate deferred trigger. Same rules, same messages; only where they run changes.
DROP TRIGGER journal_entries_foreign_shape ON journal_entries;
--> statement-breakpoint
DROP FUNCTION check_foreign_entry();
--> statement-breakpoint
CREATE FUNCTION assert_foreign_entry(e journal_entries) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  pool uuid;
  costs uuid;
  payables uuid;
  fx uuid;
  nobody constant uuid := '00000000-0000-0000-0000-000000000000'; -- stands in for "no counterparty" so the join can use =
BEGIN
  SELECT id INTO pool FROM accounts WHERE tenant_id = e.tenant_id AND code = '1010';
  SELECT id INTO costs FROM accounts WHERE tenant_id = e.tenant_id AND code = '1150';
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
       WHERE c.tenant_id = e.tenant_id AND c.entry_id = e.id AND c.account_id = costs AND c.vehicle_id = l.vehicle_id), 0)) THEN
    RAISE EXCEPTION 'entry %: a car''s supplier cost (pool payment or invoice) must go to that car''s job costs (1150): same car, same amount', e.id
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
  -- One chain per tenant: serialize this tenant's commits while we read the head and append.
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
  SELECT * INTO prev FROM journal_entry_hashes WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  INSERT INTO journal_entry_hashes (entry_id, tenant_id, seq, prev_hash, hash, payload_version)
  VALUES (NEW.id, NEW.tenant_id, coalesce(prev.seq, 0) + 1, prev.hash, journal_entry_hash(prev.hash, NEW.id, 3::smallint), 3);
  RETURN NULL;
END $$;

--> statement-breakpoint
-- The whole-entry checks are plain definer functions now, so nobody may call them directly (ledger audit of 0007, finding
-- 1: a direct call could take another tenant's ledger lock or read its figures). post_journal_entry runs as the owner.
REVOKE EXECUTE ON FUNCTION assert_foreign_entry(journal_entries), assert_fx_revaluation(journal_entries) FROM PUBLIC;
--> statement-breakpoint
-- Foreign money on the balance sheet lives only on the pool (1010) and foreign payables (2000), the two items month-end
-- revaluation restates (ADR 0011). Elsewhere it would sit at its historical rate, never revalued (ledger audit, finding 3).
-- Income and expense lines may still carry a foreign amount.
-- ponytail: chart codes again; foreign receivables or a second pool get their own revaluation item when they exist.
-- The rule isn't retroactive, so refuse to migrate over lines it would strand (unrevalued, and unreversible under it).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND a.tenant_id = l.tenant_id
              WHERE l.currency <> 'NGN' AND a.type IN ('asset', 'liability', 'equity') AND a.code NOT IN ('1010', '2000')) THEN
    RAISE EXCEPTION '0007: foreign-currency lines already sit on balance-sheet accounts other than 1010 and 2000; resolve them before migrating';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION check_line_entry_open() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  account_currency char(3);
  account_type text;
  account_code text;
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entry_hashes WHERE entry_id = NEW.entry_id) THEN
    RAISE EXCEPTION 'journal entry % is already posted; lines cannot be added', NEW.entry_id USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT currency, type, code INTO account_currency, account_type, account_code FROM accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id;
  IF account_currency IS NOT NULL AND account_currency <> NEW.currency THEN
    RAISE EXCEPTION 'a % line cannot post to a % account', NEW.currency, account_currency USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.currency <> 'NGN' AND account_type IN ('asset', 'liability', 'equity') AND account_code NOT IN ('1010', '2000') THEN
    RAISE EXCEPTION 'a % line cannot post to %: foreign money on the balance sheet lives on the pool (1010) or foreign payables (2000), which month-end revaluation restates',
      NEW.currency, account_code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
