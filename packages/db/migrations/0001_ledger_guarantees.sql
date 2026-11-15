-- Ledger guarantees that must hold no matter which code writes (CLAUDE.md → Ledger, Tenancy; ADR 0006).

-- Periods of one tenant never overlap, so every date belongs to exactly one period.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE periods ADD CONSTRAINT periods_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&);
--> statement-breakpoint

-- ── Application role ─────────────────────────────────────────────────────────────────────────────
-- The API connects as the database owner (a superuser on Railway, which bypasses RLS), then runs
-- SET LOCAL ROLE finbook_app inside every transaction. Every app query is therefore under RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finbook_app') THEN
    CREATE ROLE finbook_app NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT finbook_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO finbook_app;
--> statement-breakpoint
GRANT SELECT ON tenants, journal_entry_hashes TO finbook_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON accounts, periods TO finbook_app;
--> statement-breakpoint
-- No UPDATE or DELETE on posted rows, ever (the triggers below also stop the owner).
GRANT SELECT, INSERT ON journal_entries, journal_lines, audit_log TO finbook_app;
--> statement-breakpoint

-- ── Row-level security ───────────────────────────────────────────────────────────────────────────
-- Unset or empty app.tenant_id gives NULL, which matches no row: fail closed.
CREATE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants TO finbook_app USING (id = app_tenant_id());
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts', 'periods', 'journal_entries', 'journal_lines', 'journal_entry_hashes', 'audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO finbook_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── Append-only: posted entries, lines, hashes and the audit log ─────────────────────────────────
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: posted ledger and audit rows are append-only (correct with a reversal)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['journal_entries', 'journal_lines', 'journal_entry_hashes', 'audit_log'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_change()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── Periods: an entry must fall inside an open period; locked periods never change ──────────────
CREATE FUNCTION check_entry_period() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
CREATE TRIGGER journal_entries_period_open BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION check_entry_period();
--> statement-breakpoint
CREATE FUNCTION guard_period_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.starts_on <> OLD.starts_on OR NEW.ends_on <> OLD.ends_on THEN
    RAISE EXCEPTION 'a period''s tenant and dates cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'locked' THEN
    -- ponytail: no reopen yet. Phase 4 (month-end) adds firm_admin reopen with a logged reason.
    RAISE EXCEPTION 'locked period % to % cannot change', OLD.starts_on, OLD.ends_on USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER periods_guard BEFORE UPDATE ON periods FOR EACH ROW EXECUTE FUNCTION guard_period_update();
--> statement-breakpoint

-- ── Posting: balance check and hash chain at commit ──────────────────────────────────────────────
-- Canonical content of an entry for hashing. Fields are listed explicitly so that adding a column
-- later never changes the hash of an old entry.
CREATE FUNCTION journal_entry_payload(p_entry uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', e.id, 'tenant_id', e.tenant_id, 'period_id', e.period_id, 'entry_date', e.entry_date,
    'memo', e.memo, 'source_type', e.source_type, 'source_id', e.source_id,
    'reverses_entry_id', e.reverses_entry_id, 'idempotency_key', e.idempotency_key, 'created_by', e.created_by,
    'lines', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', l.id, 'account_id', l.account_id, 'debit_ngn', l.debit_ngn::text, 'credit_ngn', l.credit_ngn::text,
        'currency', l.currency, 'amount_minor', l.amount_minor::text, 'rate', l.rate::text,
        'rate_source', l.rate_source, 'rate_note', l.rate_note
      ) ORDER BY l.id), '[]'::jsonb)
      FROM journal_lines l WHERE l.entry_id = e.id
    )
  )::text
  FROM journal_entries e WHERE e.id = p_entry
$$;
--> statement-breakpoint
CREATE FUNCTION post_journal_entry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
  -- One chain per tenant: serialize this tenant's commits while we read the head and append.
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:' || NEW.tenant_id::text, 0));
  SELECT * INTO prev FROM journal_entry_hashes WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  INSERT INTO journal_entry_hashes (entry_id, tenant_id, seq, prev_hash, hash)
  VALUES (NEW.id, NEW.tenant_id, coalesce(prev.seq, 0) + 1, prev.hash,
          encode(sha256(convert_to(coalesce(prev.hash, '') || journal_entry_payload(NEW.id), 'UTF8')), 'hex'));
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_post AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION post_journal_entry();
--> statement-breakpoint
-- Lines belong to the transaction that created their entry. Once the entry is posted (hashed), no more lines.
CREATE FUNCTION check_line_entry_open() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entry_hashes WHERE entry_id = NEW.entry_id) THEN
    RAISE EXCEPTION 'journal entry % is already posted; lines cannot be added', NEW.entry_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_entry_open BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION check_line_entry_open();
--> statement-breakpoint

-- Every place the chain is broken for a tenant: a wrong hash, a wrong or missing predecessor,
-- or an entry with no hash row. Empty result = intact. Runs under the caller's RLS.
CREATE FUNCTION ledger_chain_breaks(p_tenant uuid) RETURNS TABLE (seq bigint, entry_id uuid, problem text) LANGUAGE sql STABLE AS $$
  SELECT h.seq, h.entry_id,
         CASE WHEN h.seq > 1 AND p.entry_id IS NULL THEN 'missing predecessor'
              WHEN h.prev_hash IS DISTINCT FROM p.hash THEN 'prev_hash mismatch'
              ELSE 'content changed' END
  FROM journal_entry_hashes h
  LEFT JOIN journal_entry_hashes p ON p.tenant_id = h.tenant_id AND p.seq = h.seq - 1
  WHERE h.tenant_id = p_tenant
    AND ((h.seq > 1 AND p.entry_id IS NULL)
      OR h.prev_hash IS DISTINCT FROM p.hash
      OR h.hash <> encode(sha256(convert_to(coalesce(h.prev_hash, '') || journal_entry_payload(h.entry_id), 'UTF8')), 'hex'))
  UNION ALL
  SELECT NULL, e.id, 'entry without hash'
  FROM journal_entries e
  WHERE e.tenant_id = p_tenant AND NOT EXISTS (SELECT 1 FROM journal_entry_hashes h WHERE h.entry_id = e.id)
  ORDER BY 1 NULLS LAST
$$;
