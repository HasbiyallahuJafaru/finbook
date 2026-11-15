CREATE TABLE "currencies" (
	"code" char(3) PRIMARY KEY NOT NULL,
	"exponent" smallint NOT NULL,
	CONSTRAINT "currencies_code" CHECK ("currencies"."code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "currencies_exponent" CHECK ("currencies"."exponent" = 2)
);
--> statement-breakpoint
-- Hand-added: currencies in use (spec → Currency and FX). Must exist before the foreign keys below.
INSERT INTO currencies (code, exponent) VALUES ('NGN', 2), ('CNY', 2), ('USD', 2);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_reversed_once";--> statement-breakpoint
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_fx";--> statement-breakpoint
ALTER TABLE "journal_entry_hashes" ADD COLUMN "payload_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "evidence_document_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "vehicle_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "counterparty_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_functional_currency_currencies_code_fk" FOREIGN KEY ("functional_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversed_once" UNIQUE("tenant_id","reverses_entry_id");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_memo" CHECK (btrim("journal_entries"."memo") <> '');--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_fx" CHECK (coalesce(case when "journal_lines"."currency" = 'NGN'
    then "journal_lines"."rate" is null and "journal_lines"."rate_source" is null and "journal_lines"."amount_minor" = "journal_lines"."debit_ngn" + "journal_lines"."credit_ngn"
    else "journal_lines"."rate" > 0 and "journal_lines"."amount_minor" > 0
      and "journal_lines"."rate_source" in ('bank_receipt', 'bdc_receipt', 'agent_invoice', 'manual')
      and ("journal_lines"."rate_source" <> 'manual' or btrim("journal_lines"."rate_note") <> '')
      and "journal_lines"."debit_ngn" + "journal_lines"."credit_ngn" = round("journal_lines"."amount_minor" * "journal_lines"."rate")
    end, false));