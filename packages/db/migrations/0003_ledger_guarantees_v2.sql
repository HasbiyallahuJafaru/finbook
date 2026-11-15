-- Ledger guarantees v2: fixes from the ledger-auditor and security-reviewer passes on phase 1 (ADR 0006).
-- Forward-only: 0001 stays as it was; this migration replaces functions and tightens privileges.

-- ── Privileges: no superuser on the app path, least privilege per column ─────────────────────────
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()); END $$;
--> statement-breakpoint
-- The API logs in as finbook_api: not a superuser, not the owner, no privileges of its own (NOINHERIT).
-- Its only power is SET ROLE finbook_app, which is under RLS. Any escape (RESET ROLE, COMMIT, a nested
-- transaction) lands on a role that can read nothing. The password is set outside migrations (src/migrate.ts).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finbook_api') THEN
    CREATE ROLE finbook_api LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;
--> statement-breakpoint
GRANT finbook_app TO finbook_api;
--> statement-breakpoint
-- Column-level grants: the app can never choose ids, stamps or system flags, and can only rename accounts.
REVOKE INSERT, UPDATE ON accounts, periods FROM finbook_app;
--> statement-breakpoint
REVOKE INSERT ON journal_entries, journal_lines, audit_log FROM finbook_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, code, name, type, currency, parent_id) ON accounts TO finbook_app;
--> statement-breakpoint
GRANT UPDATE (name, parent_id) ON accounts TO finbook_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, starts_on, ends_on) ON periods TO finbook_app;
--> statement-breakpoint
GRANT UPDATE (status, locked_by, locked_at) ON periods TO finbook_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, period_id, entry_date, memo, source_type, source_id, reverses_entry_id, idempotency_key)
  ON journal_entries TO finbook_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, rate_note,
              evidence_document_id, vehicle_id, counterparty_id)
  ON journal_lines TO finbook_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, action, entity, entity_id, before, after, ip) ON audit_log TO finbook_app;
--> statement-breakpoint
GRANT SELECT ON currencies TO finbook_app;
--> statement-breakpoint

-- ── Who and when are stamped by the database, never supplied by the app ─────────────────────────
CREATE FUNCTION app_user_id() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(btrim(current_setting('app.user_id', true)), '')
$$;
--> statement-breakpoint
CREATE FUNCTION stamp_actor() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE actor text := app_user_id();
BEGIN
  IF current_user = 'finbook_app' THEN
    IF actor IS NULL THEN
      RAISE EXCEPTION 'app.user_id is not set: every write needs an actor' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_TABLE_NAME = 'journal_entries' THEN
      NEW.created_by := actor;
      NEW.created_at := now();
    ELSE
      NEW.actor := actor;
      NEW.at := now();
    END IF;
  -- Owner path (migrations, admin jobs, bundle import): keep supplied values so restored history stays exact.
  ELSIF TG_TABLE_NAME = 'journal_entries' THEN
    NEW.created_by := coalesce(NEW.created_by, actor, 'system:' || session_user);
  ELSE
    NEW.actor := coalesce(NEW.actor, actor, 'system:' || session_user);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_stamp BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE TRIGGER audit_log_stamp BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint

-- ── Every change to accounts, periods and entries leaves an audit row in the same transaction ────
CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO audit_log (tenant_id, action, entity, entity_id, before, after)
  VALUES (NEW.tenant_id, lower(TG_OP), TG_TABLE_NAME, NEW.id,
          CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW));
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER accounts_audit AFTER INSERT OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER periods_audit AFTER INSERT OR UPDATE ON periods FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER journal_entries_audit AFTER INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint

-- ── Accounts and periods cannot change what posted history means ─────────────────────────────────
CREATE FUNCTION guard_account_update() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.tenant_id, NEW.code, NEW.type, NEW.currency) IS DISTINCT FROM (OLD.tenant_id, OLD.code, OLD.type, OLD.currency)
     AND EXISTS (SELECT 1 FROM journal_lines WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION 'account % has posted lines: its code, type and currency are fixed (rename it, or open a new account)', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER accounts_guard BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION guard_account_update();
--> statement-breakpoint
CREATE TRIGGER periods_no_delete BEFORE DELETE ON periods FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint

-- ── Insert-time checks run as the caller, so RLS hides other tenants' rows (no existence oracle) ─
CREATE OR REPLACE FUNCTION check_entry_period() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE p periods%ROWTYPE;
BEGIN
  -- FOR SHARE: a concurrent lock of this period waits until this entry commits or rolls back.
  SELECT * INTO p FROM periods WHERE id = NEW.period_id AND tenant_id = NEW.tenant_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'period % does not exist for this tenant', NEW.period_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.entry_date < p.starts_on OR NEW.entry_date > p.ends_on THEN
    RAISE EXCEPTION 'entry date % is outside its period (% to %)', NEW.entry_date, p.starts_on, p.ends_on USING ERRCODE = 'check_violation';
  END IF;
  IF p.status = 'locked' THEN
    RAISE EXCEPTION 'period % to % is locked; post the correction in an open period', p.starts_on, p.ends_on USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION check_line_entry_open() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE account_currency char(3);
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entry_hashes WHERE entry_id = NEW.entry_id) THEN
    RAISE EXCEPTION 'journal entry % is already posted; lines cannot be added', NEW.entry_id USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT currency INTO account_currency FROM accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id;
  IF account_currency IS NOT NULL AND account_currency <> NEW.currency THEN
    RAISE EXCEPTION 'a % line cannot post to a % account', NEW.currency, account_currency USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- ── Hash chain, versioned ────────────────────────────────────────────────────────────────────────
-- Canonical payload: Postgres jsonb text of an object with the fields below (keys sorted by length,
-- then bytewise; bigints and rates as strings; dates ISO; lines ordered by id). Version 1 is the 0001
-- format; version 2 adds the line links. A version's field list never changes. ADR 0006 → Hash format.
CREATE FUNCTION journal_entry_payload(p_entry uuid, p_version smallint) RETURNS text LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
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
        ORDER BY l.id), '[]'::jsonb)
      FROM journal_lines l WHERE l.entry_id = e.id
    )
  ) || CASE WHEN p_version >= 2 THEN jsonb_build_object('payload_version', p_version) ELSE '{}'::jsonb END)::text
  FROM journal_entries e WHERE e.id = p_entry
$$;
--> statement-breakpoint
CREATE FUNCTION journal_entry_hash(p_prev text, p_entry uuid, p_version smallint) RETURNS text LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT encode(sha256(convert_to(coalesce(p_prev, '') || journal_entry_payload(p_entry, p_version), 'UTF8')), 'hex')
$$;
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
      (SELECT account_id, credit_ngn, debit_ngn, currency, amount_minor, rate FROM journal_lines WHERE entry_id = NEW.reverses_entry_id
       EXCEPT ALL
       SELECT account_id, debit_ngn, credit_ngn, currency, amount_minor, rate FROM journal_lines WHERE entry_id = NEW.id)
      UNION ALL
      (SELECT account_id, debit_ngn, credit_ngn, currency, amount_minor, rate FROM journal_lines WHERE entry_id = NEW.id
       EXCEPT ALL
       SELECT account_id, credit_ngn, debit_ngn, currency, amount_minor, rate FROM journal_lines WHERE entry_id = NEW.reverses_entry_id)
    ) THEN
      RAISE EXCEPTION 'reversal % does not mirror entry %: every line must match with debit and credit swapped', NEW.id, NEW.reverses_entry_id
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
--> statement-breakpoint
-- At commit, after the entry is hashed: every line inserted in this transaction must be covered by that hash.
-- Closes the race where a line joins an entry that another transaction is committing.
CREATE FUNCTION verify_line_posted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE h journal_entry_hashes%ROWTYPE;
BEGIN
  SELECT * INTO h FROM journal_entry_hashes WHERE entry_id = NEW.entry_id;
  IF NOT FOUND OR h.hash IS DISTINCT FROM journal_entry_hash(h.prev_hash, NEW.entry_id, h.payload_version) THEN
    RAISE EXCEPTION 'line % was added to journal entry % after it was posted', NEW.id, NEW.entry_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_posted AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_line_posted();
--> statement-breakpoint
-- Every break in a tenant's chain: wrong hash, wrong or missing predecessor, a hash row whose entry is
-- gone, or an entry with no hash row. Only for the caller's own tenant. Empty = intact up to the head;
-- truncation of the newest entries is only detectable against an off-site anchor (ADR 0006).
CREATE OR REPLACE FUNCTION ledger_chain_breaks(p_tenant uuid) RETURNS TABLE (seq bigint, entry_id uuid, problem text)
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF current_user = 'finbook_app' AND p_tenant IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'ledger_chain_breaks: % is not the current tenant', p_tenant USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT h.seq, h.entry_id,
         CASE WHEN e.id IS NULL THEN 'entry missing'
              WHEN h.seq > 1 AND p.entry_id IS NULL THEN 'missing predecessor'
              WHEN h.prev_hash IS DISTINCT FROM p.hash THEN 'prev_hash mismatch'
              ELSE 'content changed' END
  FROM journal_entry_hashes h
  LEFT JOIN journal_entry_hashes p ON p.tenant_id = h.tenant_id AND p.seq = h.seq - 1
  LEFT JOIN journal_entries e ON e.id = h.entry_id
  WHERE h.tenant_id = p_tenant
    AND (e.id IS NULL
      OR (h.seq > 1 AND p.entry_id IS NULL)
      OR h.prev_hash IS DISTINCT FROM p.hash
      OR h.hash IS DISTINCT FROM journal_entry_hash(h.prev_hash, h.entry_id, h.payload_version))
  UNION ALL
  SELECT NULL::bigint, e.id, 'entry without hash'
  FROM journal_entries e
  WHERE e.tenant_id = p_tenant AND NOT EXISTS (SELECT 1 FROM journal_entry_hashes x WHERE x.entry_id = e.id)
  ORDER BY 1 NULLS LAST;
END $$;
--> statement-breakpoint
DROP FUNCTION journal_entry_payload(uuid);
