CREATE TABLE "firm_access" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_access_tenant_user" UNIQUE("tenant_id","clerk_user_id"),
	CONSTRAINT "firm_access_role" CHECK ("firm_access"."role" in ('firm_admin', 'firm_accountant', 'firm_reviewer'))
);
--> statement-breakpoint
CREATE TABLE "firm_staff" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"role" text,
	"revoked_at" timestamp with time zone,
	"clerk_event_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_user" UNIQUE("tenant_id","clerk_user_id"),
	CONSTRAINT "memberships_role" CHECK ("memberships"."role" in ('client_owner', 'client_staff', 'client_viewer')),
	CONSTRAINT "memberships_role_or_revoked" CHECK (("memberships"."role" IS NULL) = ("memberships"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "firm_access" ADD CONSTRAINT "firm_access_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_access" ADD CONSTRAINT "firm_access_clerk_user_id_firm_staff_clerk_user_id_fk" FOREIGN KEY ("clerk_user_id") REFERENCES "public"."firm_staff"("clerk_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- Hand-added: who may act in a tenant (spec → Multi-tenancy, ADR 0013).
-- Request handlers (finbook_app) only READ access rows. Only the Clerk webhook writes memberships, and it does so as
-- finbook_sync through its own login (finbook_hook), so no request handler can promote anyone, even with a bug.
-- Nobody deletes: a removal sets revoked_at, which leaves an audit row. firm_staff and firm_access are written by the
-- owner until the firm-admin endpoint lands with its own grant.
GRANT SELECT ON memberships, firm_access, firm_staff TO finbook_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships', 'firm_access'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO finbook_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- A client user arrives with only their active Clerk Organization (verified from the token). The API sets
-- app.clerk_org_id for that one lookup, so it sees the one tenant row of that org and nothing else.
CREATE POLICY tenant_by_org ON tenants FOR SELECT TO finbook_app
  USING (clerk_org_id = nullif(current_setting('app.clerk_org_id', true), ''));
--> statement-breakpoint

-- ── The webhook's role and login ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finbook_sync') THEN
    CREATE ROLE finbook_sync NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finbook_hook') THEN
    CREATE ROLE finbook_hook LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;
--> statement-breakpoint
GRANT finbook_sync TO finbook_hook;
--> statement-breakpoint
GRANT finbook_sync TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO finbook_sync;
--> statement-breakpoint
GRANT SELECT ON tenants, memberships, firm_staff TO finbook_sync;
--> statement-breakpoint
GRANT INSERT (tenant_id, clerk_user_id, role, revoked_at, clerk_event_ms), UPDATE (role, revoked_at, clerk_event_ms) ON memberships TO finbook_sync;
--> statement-breakpoint
GRANT INSERT (tenant_id, action, entity, entity_id, before, after, ip) ON audit_log TO finbook_sync;
--> statement-breakpoint
CREATE POLICY sync_by_org ON tenants FOR SELECT TO finbook_sync
  USING (clerk_org_id = nullif(current_setting('app.clerk_org_id', true), ''));
--> statement-breakpoint
CREATE POLICY sync_isolation ON memberships TO finbook_sync USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY sync_isolation ON audit_log FOR INSERT TO finbook_sync WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
-- A Clerk event time far in the future would make every later event "stale" and freeze that member: refuse it.
ALTER TABLE memberships ADD CONSTRAINT memberships_event_time CHECK (clerk_event_ms >= 0 AND clerk_event_ms < 4102444800000);
--> statement-breakpoint
-- stamp_actor (0003) stamps the actor only for finbook_app; the webhook's role must be stamped the same way.
CREATE OR REPLACE FUNCTION stamp_actor() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE actor text := app_user_id();
BEGIN
  IF current_user IN ('finbook_app', 'finbook_sync') THEN
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
