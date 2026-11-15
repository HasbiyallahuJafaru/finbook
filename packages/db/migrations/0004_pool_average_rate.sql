ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_fx";--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_fx" CHECK (coalesce(case when "journal_lines"."currency" = 'NGN'
    then "journal_lines"."rate" is null and "journal_lines"."rate_source" is null and "journal_lines"."amount_minor" = "journal_lines"."debit_ngn" + "journal_lines"."credit_ngn"
    else "journal_lines"."rate" > 0 and "journal_lines"."amount_minor" > 0
      and "journal_lines"."rate_source" in ('bank_receipt', 'bdc_receipt', 'agent_invoice', 'manual', 'pool_average')
      and ("journal_lines"."rate_source" <> 'manual' or btrim("journal_lines"."rate_note") <> '')
      and case when "journal_lines"."rate_source" = 'pool_average'
        then "journal_lines"."rate" = round(("journal_lines"."debit_ngn" + "journal_lines"."credit_ngn")::numeric / "journal_lines"."amount_minor", 6)
        else "journal_lines"."debit_ngn" + "journal_lines"."credit_ngn" = round("journal_lines"."amount_minor" * "journal_lines"."rate")
      end
    end, false));--> statement-breakpoint
-- Hand-added (ledger-auditor findings 1 and 2, ADR 0008): a pool_average line must be money leaving the pool
-- at exactly the pool's weighted-average cost, re-computed here from the ledger under the tenant's ledger lock.
CREATE FUNCTION check_pool_line() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  bal numeric;
  cost numeric;
  expected numeric;
BEGIN
  IF NEW.rate_source IS DISTINCT FROM 'pool_average' THEN
    RETURN NEW;
  END IF;
  IF NEW.credit_ngn <= 0 THEN
    -- The one exception: a reversal puts currency back exactly as it left (the commit-time mirror check proves it).
    IF EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.entry_id AND reverses_entry_id IS NOT NULL) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a pool_average line must be a credit: currency only leaves the pool at its average cost' USING ERRCODE = 'check_violation';
  END IF;
  -- Same lock as the posting trigger, held to commit: one tenant's pool movements are serialized, so two
  -- payments can never both spend the same balance. Taken before reading, so the read sees committed spends.
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
  SELECT coalesce(sum(CASE WHEN debit_ngn > 0 THEN amount_minor ELSE -amount_minor END), 0), coalesce(sum(debit_ngn - credit_ngn), 0)
    INTO bal, cost
    FROM journal_lines WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id AND currency = NEW.currency;
  IF NEW.amount_minor > bal THEN
    RAISE EXCEPTION 'pool overspent: % % requested but only % in the pool', NEW.amount_minor, NEW.currency, bal USING ERRCODE = 'check_violation';
  END IF;
  expected := CASE WHEN NEW.amount_minor = bal THEN cost ELSE round(cost * NEW.amount_minor / bal) END;
  IF NEW.credit_ngn <> expected THEN
    RAISE EXCEPTION 'a pool_average line must carry the pool''s weighted-average cost: expected % kobo, got %', expected, NEW.credit_ngn
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_pool_cost BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION check_pool_line();

--> statement-breakpoint
-- Hand-added (ledger-auditor): a reversal must also mirror each line's rate source, car and customer.
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
      (SELECT account_id, credit_ngn, debit_ngn, currency, amount_minor, rate, rate_source, vehicle_id, counterparty_id FROM journal_lines WHERE entry_id = NEW.reverses_entry_id
       EXCEPT ALL
       SELECT account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, vehicle_id, counterparty_id FROM journal_lines WHERE entry_id = NEW.id)
      UNION ALL
      (SELECT account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, vehicle_id, counterparty_id FROM journal_lines WHERE entry_id = NEW.id
       EXCEPT ALL
       SELECT account_id, credit_ngn, debit_ngn, currency, amount_minor, rate, rate_source, vehicle_id, counterparty_id FROM journal_lines WHERE entry_id = NEW.reverses_entry_id)
    ) THEN
      RAISE EXCEPTION 'reversal % does not mirror entry %: every line (account, amounts, currency, rate, rate source, car, customer) must match with debit and credit swapped', NEW.id, NEW.reverses_entry_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- One chain per tenant: serialize this tenant's commits while we read the head and append.
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
  SELECT * INTO prev FROM journal_entry_hashes WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  INSERT INTO journal_entry_hashes (entry_id, tenant_id, seq, prev_hash, hash, payload_version)
  VALUES (NEW.id, NEW.tenant_id, coalesce(prev.seq, 0) + 1, prev.hash, journal_entry_hash(prev.hash, NEW.id, 2::smallint), 2);
  RETURN NULL;
END $$;
