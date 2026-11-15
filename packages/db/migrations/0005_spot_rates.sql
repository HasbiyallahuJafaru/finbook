CREATE TABLE "fx_reference_rates" (
	"rate_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"rate" numeric(18, 6) NOT NULL,
	"source" text NOT NULL,
	"revision" smallint DEFAULT 1 NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_reference_rates_day" UNIQUE("rate_date","currency","source","revision"),
	CONSTRAINT "fx_reference_rates_revision" CHECK ("fx_reference_rates"."revision" >= 1),
	CONSTRAINT "fx_reference_rates_positive" CHECK ("fx_reference_rates"."rate" > 0),
	CONSTRAINT "fx_reference_rates_not_ngn" CHECK ("fx_reference_rates"."currency" <> 'NGN'),
	CONSTRAINT "fx_reference_rates_source" CHECK ("fx_reference_rates"."source" in ('cbn', 'market'))
);
--> statement-breakpoint
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_fx";--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "spot_rate" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "spot_source" text;--> statement-breakpoint
ALTER TABLE "fx_reference_rates" ADD CONSTRAINT "fx_reference_rates_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_spot" CHECK (coalesce(case
    when "journal_lines"."currency" = 'NGN' then "journal_lines"."spot_rate" is null and "journal_lines"."spot_source" is null
    else ("journal_lines"."spot_rate" is null) = ("journal_lines"."spot_source" is null) and ("journal_lines"."spot_rate" is null or ("journal_lines"."spot_rate" > 0 and "journal_lines"."spot_source" in ('cbn', 'manual')))
    end and ("journal_lines"."spot_source" is distinct from 'manual' or btrim("journal_lines"."rate_note") <> ''), false)) NOT VALID;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_fx" CHECK (coalesce(case when "journal_lines"."currency" = 'NGN'
    then "journal_lines"."rate" is null and "journal_lines"."rate_source" is null and "journal_lines"."amount_minor" = "journal_lines"."debit_ngn" + "journal_lines"."credit_ngn"
    else "journal_lines"."rate" > 0 and "journal_lines"."amount_minor" > 0
      and "journal_lines"."rate_source" in ('bank_receipt', 'bdc_receipt', 'agent_invoice', 'manual', 'pool_average', 'payable_average')
      and ("journal_lines"."rate_source" <> 'manual' or btrim("journal_lines"."rate_note") <> '')
      and case when "journal_lines"."rate_source" in ('pool_average', 'payable_average')
        then "journal_lines"."rate" = round(("journal_lines"."debit_ngn" + "journal_lines"."credit_ngn")::numeric / "journal_lines"."amount_minor", 6)
        else "journal_lines"."debit_ngn" + "journal_lines"."credit_ngn" = round("journal_lines"."amount_minor" * "journal_lines"."rate")
      end
    end, false));
--> statement-breakpoint
-- Hand-added below: roles, grants and guarantees for spot rates and supplier payables (ADR 0009, 0010).
-- The worker's login for the daily rate snapshot: it can add and read reference rates, nothing else (no tenant
-- data, not a superuser). Its password is set outside migrations (src/migrate.ts).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finbook_rates') THEN
    CREATE ROLE finbook_rates LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO finbook_rates;
--> statement-breakpoint
GRANT SELECT, INSERT ON fx_reference_rates TO finbook_rates;
--> statement-breakpoint
GRANT SELECT ON fx_reference_rates TO finbook_app;
--> statement-breakpoint
GRANT INSERT (spot_rate, spot_source) ON journal_lines TO finbook_app;
--> statement-breakpoint
-- Reference rates are evidence for revaluation and the spot basis: append-only. A wrong rate is corrected by
-- inserting a higher revision for the same day and source; readers take the highest revision fetched by then.
CREATE TRIGGER fx_reference_rates_append_only BEFORE UPDATE OR DELETE ON fx_reference_rates FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER fx_reference_rates_no_truncate BEFORE TRUNCATE ON fx_reference_rates FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
-- Spot rates (ADR 0009, 0010). Pool payments and supplier invoices need the day's spot rate; one marked 'cbn' must be
-- the CBN central rate last published on or before the entry date, at most 7 days earlier (latest revision).
-- Reversals are exempt: the commit-time mirror check proves them, and lines posted before 0005 have no spot rate.
CREATE FUNCTION check_spot_source() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  e journal_entries%ROWTYPE;
  ref fx_reference_rates%ROWTYPE;
BEGIN
  IF NEW.currency = 'NGN' THEN
    RETURN NEW; -- NGN lines never carry a spot rate: journal_lines_spot refuses one
  END IF;
  SELECT * INTO e FROM journal_entries WHERE id = NEW.entry_id;
  IF e.reverses_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.rate_source IN ('pool_average', 'agent_invoice') AND NEW.spot_rate IS NULL THEN
    RAISE EXCEPTION 'a % line needs the day''s spot rate and its source (cbn, or manual with a note)', NEW.rate_source USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.spot_source IS DISTINCT FROM 'cbn' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO ref FROM fx_reference_rates
   WHERE currency = NEW.currency AND source = 'cbn' AND rate_date <= e.entry_date AND rate_date >= e.entry_date - 7
   ORDER BY rate_date DESC, revision DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no CBN rate for % in the 7 days up to %: enter the spot rate as manual, with a note', NEW.currency, e.entry_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF ref.rate <> NEW.spot_rate THEN
    RAISE EXCEPTION 'spot rate % is marked cbn but the CBN rate for % on % is %', NEW.spot_rate, NEW.currency, ref.rate_date, ref.rate
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_spot_source BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION check_spot_source();
--> statement-breakpoint
-- Foreign money on the pool (1010) and payables (2000) moves only one way each, so the cost checks can't be skipped
-- by choosing another rate source:
--  - currency leaves the pool only as pool_average (at its average cost, check_pool_line);
--  - a foreign payable is paid down only as payable_average (at its booked cost, check_payable_line);
--  - a car with an open supplier invoice is paid through that invoice, never straight from the pool (no double cost);
--  - an invoice can't be reversed once payments were made against it (reverse the payments first).
-- Reversals of pool and payable movements are allowed; the commit-time mirror check proves they're exact.
-- ponytail: identifies the accounts by chart code (1010, 2000); add an account role column when tenants get several.
CREATE FUNCTION check_foreign_account() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  code text;
  reversal boolean;
  payables uuid;
BEGIN
  IF NEW.currency = 'NGN' THEN
    RETURN NEW;
  END IF;
  SELECT a.code INTO code FROM accounts a WHERE a.id = NEW.account_id AND a.tenant_id = NEW.tenant_id;
  SELECT e.reverses_entry_id IS NOT NULL INTO reversal FROM journal_entries e WHERE e.id = NEW.entry_id;
  IF code = '1010' AND NEW.credit_ngn > 0 AND NOT reversal THEN
    IF NEW.rate_source IS DISTINCT FROM 'pool_average' THEN
      RAISE EXCEPTION 'currency leaves the pool (1010) only at its average cost (rate source pool_average)' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.vehicle_id IS NOT NULL THEN
      SELECT a.id INTO payables FROM accounts a WHERE a.tenant_id = NEW.tenant_id AND a.code = '2000';
      IF (SELECT coalesce(sum(CASE WHEN l.credit_ngn > 0 THEN l.amount_minor ELSE -l.amount_minor END), 0)
            FROM journal_lines l WHERE l.account_id = payables AND l.vehicle_id = NEW.vehicle_id AND l.currency = NEW.currency) > 0 THEN
        RAISE EXCEPTION 'this car has an open supplier invoice: settle the invoice instead of paying from the pool again' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF code = '2000' AND NEW.debit_ngn > 0 THEN
    IF NOT reversal AND NEW.rate_source IS DISTINCT FROM 'payable_average' THEN
      RAISE EXCEPTION 'a foreign payable (2000) is paid down only at its booked cost (rate source payable_average)' USING ERRCODE = 'check_violation';
    END IF;
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
CREATE TRIGGER journal_lines_foreign_account BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION check_foreign_account();
--> statement-breakpoint
-- A payable_average line settles what's owed to one supplier for one car in one currency, at exactly the
-- weighted-average booked cost of that balance, never more than is owed. Re-computed here from the ledger,
-- under the tenant lock, like the pool (check_pool_line). Only a reversal may post it as a credit.
CREATE FUNCTION check_payable_line() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  bal numeric;
  cost numeric;
  expected numeric;
BEGIN
  IF NEW.rate_source IS DISTINCT FROM 'payable_average' THEN
    RETURN NEW;
  END IF;
  IF NEW.debit_ngn <= 0 THEN
    IF EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.entry_id AND reverses_entry_id IS NOT NULL) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a payable_average line must be a debit: it settles what is owed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.counterparty_id IS NULL OR NEW.vehicle_id IS NULL THEN
    RAISE EXCEPTION 'a payable settlement must name the supplier and the car' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
  SELECT coalesce(sum(CASE WHEN credit_ngn > 0 THEN amount_minor ELSE -amount_minor END), 0), coalesce(sum(credit_ngn - debit_ngn), 0)
    INTO bal, cost
    FROM journal_lines
   WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id AND currency = NEW.currency
     AND counterparty_id = NEW.counterparty_id AND vehicle_id = NEW.vehicle_id;
  IF NEW.amount_minor > bal THEN
    RAISE EXCEPTION 'payment of % % exceeds the % owed to this supplier for this car', NEW.amount_minor, NEW.currency, bal USING ERRCODE = 'check_violation';
  END IF;
  expected := CASE WHEN NEW.amount_minor = bal THEN cost ELSE round(cost * NEW.amount_minor / bal) END;
  IF NEW.debit_ngn <> expected THEN
    RAISE EXCEPTION 'a payable settlement must clear its booked cost: expected % kobo, got %', expected, NEW.debit_ngn USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_payable_cost BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION check_payable_line();
--> statement-breakpoint
-- Hash payload version 3 = version 2 plus each line's spot_rate and spot_source. Older entries keep their version and their hash.
CREATE OR REPLACE FUNCTION journal_entry_payload(p_entry uuid, p_version smallint) RETURNS text LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT (jsonb_build_object(
    'id', e.id, 'tenant_id', e.tenant_id, 'period_id', e.period_id, 'entry_date', e.entry_date,
    'memo', e.memo, 'source_type', e.source_type, 'source_id', e.source_id,
    'reverses_entry_id', e.reverses_entry_id, 'idempotency_key', e.idempotency_key, 'created_by', e.created_by,
    'lines', (
      SELECT coalesce(jsonb_agg(
        jsonb_build_object(
          'id', l.id, 'account_id', l.account_id, 'debit_ngn', l.debit_ngn::text, 'credit_ngn', l.credit_ngn::text,
          'currency', l.currency, 'amount_minor', l.amount_minor::text, 'rate', l.rate::text,
          'rate_source', l.rate_source, 'rate_note', l.rate_note
        ) || CASE WHEN p_version >= 2 THEN jsonb_build_object(
          'evidence_document_id', l.evidence_document_id, 'vehicle_id', l.vehicle_id, 'counterparty_id', l.counterparty_id
        ) ELSE '{}'::jsonb END
        || CASE WHEN p_version >= 3 THEN jsonb_build_object('spot_rate', l.spot_rate::text, 'spot_source', l.spot_source) ELSE '{}'::jsonb END
        ORDER BY l.id), '[]'::jsonb)
      FROM journal_lines l WHERE l.entry_id = e.id
    )
  ) || CASE WHEN p_version >= 2 THEN jsonb_build_object('payload_version', p_version) ELSE '{}'::jsonb END)::text
  FROM journal_entries e WHERE e.id = p_entry
$$;
--> statement-breakpoint
-- New entries are hashed with version 3; a reversal must also mirror each line's spot rate.
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
  -- One chain per tenant: serialize this tenant's commits while we read the head and append.
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
  SELECT * INTO prev FROM journal_entry_hashes WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  INSERT INTO journal_entry_hashes (entry_id, tenant_id, seq, prev_hash, hash, payload_version)
  VALUES (NEW.id, NEW.tenant_id, coalesce(prev.seq, 0) + 1, prev.hash, journal_entry_hash(prev.hash, NEW.id, 3::smallint), 3);
  RETURN NULL;
END $$;
