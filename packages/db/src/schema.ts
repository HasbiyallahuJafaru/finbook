// Table structure only. Ledger guarantees (RLS, triggers, grants, hash chain) live in the
// hand-written SQL migrations `0001_ledger_guarantees.sql` and `0003_ledger_guarantees_v2.sql`, because Drizzle
// can't express them. ADR 0006.
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, char, check, date, foreignKey, index, inet, jsonb, numeric, pgTable, smallint, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const currency = (name: string) => char(name, { length: 3 }).references(() => currencies.code);

/** Global, not per tenant. Only exponent-2 currencies until packages/money handles other scales (ADR 0003). */
export const currencies = pgTable('currencies', {
  code: char('code', { length: 3 }).primaryKey(),
  exponent: smallint('exponent').notNull(),
}, (t) => [
  check('currencies_code', sql`${t.code} ~ '^[A-Z]{3}$'`),
  check('currencies_exponent', sql`${t.exponent} = 2`),
]);

export const tenants = pgTable('tenants', {
  id: id(),
  clerkOrgId: text('clerk_org_id').unique(),
  legalName: text('legal_name').notNull(),
  functionalCurrency: currency('functional_currency').notNull().default('NGN'),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
}, (t) => [check('tenants_status', sql`${t.status} in ('active', 'suspended', 'closed')`)]);

export const accounts = pgTable('accounts', {
  id: id(),
  tenantId: tenantId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  currency: currency('currency'),
  parentId: uuid('parent_id'),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [
  unique('accounts_tenant_code').on(t.tenantId, t.code),
  unique('accounts_tenant_id_id').on(t.tenantId, t.id),
  foreignKey({ name: 'accounts_parent', columns: [t.tenantId, t.parentId], foreignColumns: [t.tenantId, t.id] }),
  check('accounts_type', sql`${t.type} in ('asset', 'liability', 'equity', 'income', 'expense')`),
]);

export const periods = pgTable('periods', {
  id: id(),
  tenantId: tenantId(),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  status: text('status').notNull().default('open'),
  lockedBy: text('locked_by'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
}, (t) => [
  unique('periods_tenant_id_id').on(t.tenantId, t.id),
  check('periods_dates', sql`${t.endsOn} >= ${t.startsOn}`),
  check('periods_status', sql`${t.status} in ('open', 'closing', 'locked')`),
  check('periods_locked_by', sql`${t.status} <> 'locked' or (${t.lockedBy} is not null and ${t.lockedAt} is not null)`),
]);

export const journalEntries = pgTable('journal_entries', {
  id: id(),
  tenantId: tenantId(),
  periodId: uuid('period_id').notNull(),
  entryDate: date('entry_date').notNull(),
  memo: text('memo').notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id').notNull(),
  reversesEntryId: uuid('reverses_entry_id'),
  idempotencyKey: text('idempotency_key').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('journal_entries_tenant_id_id').on(t.tenantId, t.id),
  unique('journal_entries_idempotency').on(t.tenantId, t.idempotencyKey),
  unique('journal_entries_reversed_once').on(t.tenantId, t.reversesEntryId),
  check('journal_entries_memo', sql`btrim(${t.memo}) <> ''`),
  foreignKey({ name: 'journal_entries_period', columns: [t.tenantId, t.periodId], foreignColumns: [periods.tenantId, periods.id] }),
  foreignKey({ name: 'journal_entries_reverses', columns: [t.tenantId, t.reversesEntryId], foreignColumns: [t.tenantId, t.id] }),
  index('journal_entries_tenant_date').on(t.tenantId, t.entryDate),
]);

export const journalLines = pgTable('journal_lines', {
  id: id(),
  tenantId: tenantId(),
  entryId: uuid('entry_id').notNull(),
  accountId: uuid('account_id').notNull(),
  debitNgn: bigint('debit_ngn', { mode: 'bigint' }).notNull().default(sql`0`),
  creditNgn: bigint('credit_ngn', { mode: 'bigint' }).notNull().default(sql`0`),
  currency: currency('currency').notNull().default('NGN'),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  rate: numeric('rate', { precision: 18, scale: 6 }),
  rateSource: text('rate_source'),
  rateNote: text('rate_note'),
  // Spot (reference) rate on the transaction day, confirmed by the user: required on pool payments (ADR 0009).
  spotRate: numeric('spot_rate', { precision: 18, scale: 6 }),
  // Where the spot rate came from: the stored CBN rate for the entry date, or typed in with a rate_note (ADR 0010).
  spotSource: text('spot_source'),
  // Links filled from phase 2 (vehicles, counterparties, documents); present now so the hash payload never changes shape.
  evidenceDocumentId: uuid('evidence_document_id'),
  vehicleId: uuid('vehicle_id'),
  counterpartyId: uuid('counterparty_id'),
}, (t) => [
  foreignKey({ name: 'journal_lines_entry', columns: [t.tenantId, t.entryId], foreignColumns: [journalEntries.tenantId, journalEntries.id] }),
  foreignKey({ name: 'journal_lines_account', columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
  index('journal_lines_tenant_account').on(t.tenantId, t.accountId),
  index('journal_lines_entry').on(t.entryId),
  // The per-car checks (0006, 0008) scan a car's lines under the tenant lock; partial, since most lines name no car.
  index('journal_lines_tenant_vehicle_account').on(t.tenantId, t.vehicleId, t.accountId).where(sql`${t.vehicleId} IS NOT NULL`),
  check('journal_lines_one_side', sql`${t.debitNgn} >= 0 and ${t.creditNgn} >= 0 and (${t.debitNgn} > 0) <> (${t.creditNgn} > 0)`),
  // Shape of the spot fields (ADR 0009, 0010): NGN lines never carry one; otherwise rate and source come together, and a
  // manual spot rate needs a note. Which lines must carry one is checked by the check_spot_source trigger (it knows reversals).
  check('journal_lines_spot', sql`coalesce(case
    when ${t.currency} = 'NGN' then ${t.spotRate} is null and ${t.spotSource} is null
    else (${t.spotRate} is null) = (${t.spotSource} is null) and (${t.spotRate} is null or (${t.spotRate} > 0 and ${t.spotSource} in ('cbn', 'manual')))
    end and (${t.spotSource} is distinct from 'manual' or btrim(${t.rateNote}) <> ''), false)`),
  check('journal_lines_fx', sql`coalesce(case when ${t.currency} = 'NGN'
    then ${t.rate} is null and ${t.rateSource} is null and ${t.amountMinor} = ${t.debitNgn} + ${t.creditNgn}
    else ${t.rate} > 0 and ${t.amountMinor} > 0
      and ${t.rateSource} in ('bank_receipt', 'bdc_receipt', 'agent_invoice', 'manual', 'pool_average', 'payable_average')
      and (${t.rateSource} <> 'manual' or btrim(${t.rateNote}) <> '')
      and case when ${t.rateSource} in ('pool_average', 'payable_average')
        then ${t.rate} = round((${t.debitNgn} + ${t.creditNgn})::numeric / ${t.amountMinor}, 6)
        else ${t.debitNgn} + ${t.creditNgn} = round(${t.amountMinor} * ${t.rate})
      end
    end, false)`),
]);

/** One row per posted entry, written at commit by the ledger trigger. Tamper evidence (spec → Daily backup). */
export const journalEntryHashes = pgTable('journal_entry_hashes', {
  entryId: uuid('entry_id').primaryKey(),
  tenantId: tenantId(),
  seq: bigint('seq', { mode: 'bigint' }).notNull(),
  payloadVersion: smallint('payload_version').notNull().default(1),
  prevHash: text('prev_hash'),
  hash: text('hash').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('journal_entry_hashes_seq').on(t.tenantId, t.seq),
  foreignKey({ name: 'journal_entry_hashes_entry', columns: [t.tenantId, t.entryId], foreignColumns: [journalEntries.tenantId, journalEntries.id] }),
]);

export const auditLog = pgTable('audit_log', {
  id: id(),
  tenantId: tenantId(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: inet('ip'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('audit_log_tenant_at').on(t.tenantId, t.at)]);

/**
 * Daily reference (spot) rates, global, not per tenant (spec → Currency and FX, rule 7). They pre-fill forms and
 * feed revaluation and the spot basis; the user always confirms the rate actually used. Append-only.
 */
export const fxReferenceRates = pgTable('fx_reference_rates', {
  rateDate: date('rate_date').notNull(),
  currency: char('currency', { length: 3 }).notNull().references(() => currencies.code),
  rate: numeric('rate', { precision: 18, scale: 6 }).notNull(),
  source: text('source').notNull(),
  // A wrong rate is corrected by a higher revision for the same day and source; readers take the highest.
  revision: smallint('revision').notNull().default(1),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('fx_reference_rates_day').on(t.rateDate, t.currency, t.source, t.revision),
  check('fx_reference_rates_revision', sql`${t.revision} >= 1`),
  check('fx_reference_rates_positive', sql`${t.rate} > 0`),
  check('fx_reference_rates_not_ngn', sql`${t.currency} <> 'NGN'`),
  // cbn: CBN central rate, the reference (revaluation, spot pre-fill, exceptions). market: mid-market feed, pre-fills rate paid only. ADR 0010.
  check('fx_reference_rates_source', sql`${t.source} in ('cbn', 'market')`),
]);

/**
 * Month-end revaluation evidence (spec FX rule 6, ADR 0011): one row per currency and item (the pool on 1010, foreign
 * payables on 2000) on a revaluation entry, with the balance, the carrying amount and the exact reference rate used,
 * so an auditor can re-perform the figure. Append-only; the database re-computes every row at commit (migration 0007).
 */
export const fxRevaluations = pgTable('fx_revaluations', {
  id: id(),
  tenantId: tenantId(),
  entryId: uuid('entry_id').notNull(),
  item: text('item').notNull(),
  currency: char('currency', { length: 3 }).notNull().references(() => currencies.code),
  balanceMinor: bigint('balance_minor', { mode: 'bigint' }).notNull(),
  carryingNgn: bigint('carrying_ngn', { mode: 'bigint' }).notNull(),
  rateDate: date('rate_date').notNull(),
  rateSource: text('rate_source').notNull().default('cbn'),
  rateRevision: smallint('rate_revision').notNull(),
  rate: numeric('rate', { precision: 18, scale: 6 }).notNull(),
  closingNgn: bigint('closing_ngn', { mode: 'bigint' }).notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('fx_revaluations_one_per_item').on(t.entryId, t.item, t.currency),
  foreignKey({ name: 'fx_revaluations_entry', columns: [t.tenantId, t.entryId], foreignColumns: [journalEntries.tenantId, journalEntries.id] }),
  foreignKey({ name: 'fx_revaluations_reference', columns: [t.rateDate, t.currency, t.rateSource, t.rateRevision],
    foreignColumns: [fxReferenceRates.rateDate, fxReferenceRates.currency, fxReferenceRates.source, fxReferenceRates.revision] }),
  index('fx_revaluations_tenant_currency').on(t.tenantId, t.currency),
  check('fx_revaluations_item', sql`${t.item} in ('pool', 'payables')`),
  check('fx_revaluations_not_ngn', sql`${t.currency} <> 'NGN'`),
  check('fx_revaluations_cbn', sql`${t.rateSource} = 'cbn'`),
  check('fx_revaluations_balance', sql`${t.balanceMinor} >= 0`),
  check('fx_revaluations_closing', sql`${t.closingNgn} = round(${t.balanceMinor} * ${t.rate})`),
]);

/**
 * Who may act in a tenant, and as what (spec → Multi-tenancy). The API reads the role here on every request, under RLS.
 * memberships: the client's own people, mirrored from the tenant's Clerk Organization by webhook.
 * firm_access: firm staff assigned to this client by a firm admin; the only way staff reach a tenant.
 */
export const memberships = pgTable('memberships', {
  id: id(),
  tenantId: tenantId(),
  clerkUserId: text('clerk_user_id').notNull(),
  role: text('role'),
  /** Set when Clerk removes the member (or the row must never grant access); rows are never deleted, so every change is audited. */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  /** Clerk event time (ms) of the last event applied: an older or repeated delivery changes nothing. */
  clerkEventMs: bigint('clerk_event_ms', { mode: 'bigint' }).notNull().default(sql`0`),
  createdAt: createdAt(),
}, (t) => [
  unique('memberships_tenant_user').on(t.tenantId, t.clerkUserId),
  check('memberships_role', sql`${t.role} in ('client_owner', 'client_staff', 'client_viewer')`),
  check('memberships_role_or_revoked', sql`(${t.role} IS NULL) = (${t.revokedAt} IS NOT NULL)`),
]);

/** Global, not per tenant (no client data): the people who work for the firm. Firm staff never hold a client role. */
export const firmStaff = pgTable('firm_staff', {
  clerkUserId: text('clerk_user_id').primaryKey(),
  createdAt: createdAt(),
});

export const firmAccess = pgTable('firm_access', {
  id: id(),
  tenantId: tenantId(),
  clerkUserId: text('clerk_user_id').notNull().references(() => firmStaff.clerkUserId),
  role: text('role').notNull(),
  grantedBy: text('granted_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('firm_access_tenant_user').on(t.tenantId, t.clerkUserId),
  check('firm_access_role', sql`${t.role} in ('firm_admin', 'firm_accountant', 'firm_reviewer')`),
]);
