-- Custom SQL migration file, put your code below! --
-- Evidence (owner 2026-11-17, ADR 0018):
--  - a posting without evidence still posts, and shows as evidence pending until a document is attached;
--  - a foreign-currency line needs its document (CLAUDE.md: the rate is only provable from it), so it is refused without one;
--  - a document may back several standing entries (one transfer paying for two cars posts as two entries; a corrected
--    entry takes its reversed original's slip): every document that does is listed for a firm reviewer.

-- New foreign lines only: lines posted before this rule are left as they were (NOT VALID), and stay traceable through the pool.
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_foreign_evidence CHECK (currency = 'NGN' OR evidence_document_id IS NOT NULL) NOT VALID;
--> statement-breakpoint
-- Evidence attached after posting (the entry itself never changes): one per entry, append-only, who and when from the database.
CREATE TABLE entry_evidence (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  entry_id uuid NOT NULL,
  document_id uuid NOT NULL,
  attached_by text NOT NULL DEFAULT app_user_id(),
  attached_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT entry_evidence_one_per_entry UNIQUE (tenant_id, entry_id),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id)
);
--> statement-breakpoint
GRANT SELECT, INSERT (tenant_id, entry_id, document_id) ON entry_evidence TO finbook_app;
--> statement-breakpoint
ALTER TABLE entry_evidence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE entry_evidence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON entry_evidence TO finbook_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE TRIGGER entry_evidence_audit AFTER INSERT ON entry_evidence FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER entry_evidence_no_change BEFORE UPDATE OR DELETE ON entry_evidence FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER entry_evidence_no_truncate BEFORE TRUNCATE ON entry_evidence FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
-- The evidence-pending list (spec → exception report; a month can't lock while it has entries, phase 4): every standing
-- entry of a type that moves money or books a bill, with no evidence on its lines and none attached. Completions (the
-- accepted quote is their evidence), arrivals in the yard and revaluations (their own evidence table) take none; a
-- reversal mirrors its original, and a reversed entry stands no more.
CREATE VIEW entries_missing_evidence WITH (security_invoker = true) AS
SELECT e.tenant_id, e.id AS entry_id, e.entry_date, e.source_type, e.memo
  FROM journal_entries e
 WHERE e.reverses_entry_id IS NULL
   AND e.source_type NOT IN ('job_completion', 'yard_arrival', 'fx_revaluation')
   AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.tenant_id = e.tenant_id AND r.reverses_entry_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.tenant_id = e.tenant_id AND l.entry_id = e.id AND l.evidence_document_id IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM entry_evidence x WHERE x.tenant_id = e.tenant_id AND x.entry_id = e.id);
--> statement-breakpoint
GRANT SELECT ON entries_missing_evidence TO finbook_app;
--> statement-breakpoint
-- Attaching evidence later: a stored document of this tenant (the same answer for another tenant's, a missing one or a
-- pending upload: it runs as the app, under RLS), and only to a standing entry that has none yet.
CREATE FUNCTION guard_entry_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM documents WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id AND status = 'stored') THEN
    RAISE EXCEPTION 'evidence must be a stored document: confirm the upload first' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM entries_missing_evidence WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.entry_id) THEN
    RAISE EXCEPTION 'that entry already has its evidence, or takes none' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER entry_evidence_guard BEFORE INSERT ON entry_evidence FOR EACH ROW EXECUTE FUNCTION guard_entry_evidence();
--> statement-breakpoint
-- Shared evidence, for a firm reviewer (owner 2026-11-17: allowed, listed): each file (the same bytes uploaded twice count as
-- one) backing more than one standing entry, on a line or attached, with the entries it backs. A reversed entry and its
-- reversal stand no more, so a correction that takes its original's slip shares nothing.
CREATE VIEW evidence_shared WITH (security_invoker = true) AS
WITH uses AS (
  SELECT l.tenant_id, l.entry_id, l.evidence_document_id AS document_id FROM journal_lines l WHERE l.evidence_document_id IS NOT NULL
  UNION
  SELECT x.tenant_id, x.entry_id, x.document_id FROM entry_evidence x
), standing AS (
  SELECT u.tenant_id, d.sha256, u.document_id, u.entry_id
    FROM uses u
    JOIN documents d ON d.tenant_id = u.tenant_id AND d.id = u.document_id
    JOIN journal_entries e ON e.tenant_id = u.tenant_id AND e.id = u.entry_id
   WHERE e.reverses_entry_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.tenant_id = e.tenant_id AND r.reverses_entry_id = e.id)
)
SELECT tenant_id, sha256, array_agg(DISTINCT document_id) AS document_ids, array_agg(DISTINCT entry_id) AS entry_ids
  FROM standing GROUP BY tenant_id, sha256 HAVING count(DISTINCT entry_id) > 1;
--> statement-breakpoint
GRANT SELECT ON evidence_shared TO finbook_app;
--> statement-breakpoint
-- Four eyes: a reviewer who attached evidence to any of the car's entries, or uploaded it, doesn't sign off its flags
-- (ledger audit of 0017). Otherwise as in 0016.
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
                     WHERE c.tenant_id = NEW.tenant_id AND c.vehicle_id = f.vehicle_id AND d.evidence_document_id IS NOT NULL
                     UNION SELECT x.document_id FROM entry_evidence x JOIN journal_lines c ON c.tenant_id = x.tenant_id AND c.entry_id = x.entry_id
                     WHERE x.tenant_id = NEW.tenant_id AND c.vehicle_id = f.vehicle_id))
               OR (a.entity = 'entry_evidence' AND (a.after ->> 'entry_id')::uuid IN (SELECT entry_id FROM journal_lines
                     WHERE tenant_id = NEW.tenant_id AND vehicle_id = f.vehicle_id))))
       OR EXISTS (SELECT 1 FROM journal_entries e JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
                   WHERE e.tenant_id = NEW.tenant_id AND l.vehicle_id = f.vehicle_id AND e.created_by = NEW.signed_by) THEN
      RAISE EXCEPTION 'a flag is signed off by someone who touched nothing it is about: not the job, its cars, its customer, its quote, its evidence or any entry for the car' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
