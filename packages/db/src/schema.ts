// Table structure only. Ledger guarantees (RLS, triggers, grants, hash chain) live in the
// hand-written SQL migrations `0001_ledger_guarantees.sql` and `0003_ledger_guarantees_v2.sql`, because Drizzle
// can't express them. ADR 0006.
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, char, check, date, foreignKey, index, inet, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp, unique, uuid,
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

/** Suppliers, clearing agents and buyers (spec → Data model). Journal lines name them by counterparty_id. */
export const counterparties = pgTable('counterparties', {
  id: id(),
  tenantId: tenantId(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  tin: text('tin'),
  createdAt: createdAt(),
}, (t) => [
  unique('counterparties_tenant_id_id').on(t.tenantId, t.id),
  unique('counterparties_tenant_id_id_kind').on(t.tenantId, t.id, t.kind),
  index('counterparties_tenant_kind').on(t.tenantId, t.kind),
  check('counterparties_kind', sql`${t.kind} in ('supplier', 'agent', 'customer')`),
  check('counterparties_name', sql`btrim(${t.name}) <> ''`),
]);

/**
 * One row per car, costed by specific identification (spec → Vehicle module). vin_status is computed by the
 * database (vin_status_of, migration 0011): a VIN that fails the check is kept as typed, flagged vin_needs_correction.
 */
export const vehicles = pgTable('vehicles', {
  id: id(),
  tenantId: tenantId(),
  vin: text('vin').notNull(),
  vinStatus: text('vin_status').notNull().generatedAlwaysAs(sql`vin_status_of(vin)`),
  make: text('make').notNull(),
  model: text('model').notNull(),
  year: smallint('year').notNull(),
  colour: text('colour'),
  mileage: integer('mileage'),
  direction: text('direction').notNull().default('import'),
  status: text('status').notNull().default('purchased'),
  purchaseDate: date('purchase_date'),
  soldDate: date('sold_date'),
  createdAt: createdAt(),
}, (t) => [
  unique('vehicles_tenant_vin').on(t.tenantId, t.vin),
  unique('vehicles_tenant_id_id').on(t.tenantId, t.id),
  index('vehicles_tenant_status').on(t.tenantId, t.status),
  check('vehicles_vin_shape', sql`${t.vin} = upper(btrim(${t.vin})) AND ${t.vin} <> ''`),
  check('vehicles_year', sql`${t.year} BETWEEN 1950 AND 2100`),
  check('vehicles_mileage', sql`${t.mileage} >= 0`),
  check('vehicles_direction', sql`${t.direction} in ('import', 'export', 'local')`),
  check('vehicles_status', sql`${t.status} in ('purchased', 'in_transit', 'at_port', 'in_yard', 'reserved', 'sold', 'delivered', 'written_off', 'returned')`),
]);

/**
 * One row per write the API accepted with an Idempotency-Key, written in the same transaction as the write: a retry
 * with the same key and body gets the stored answer, the same key with another body is refused.
 */
export const idempotencyKeys = pgTable('idempotency_keys', {
  tenantId: tenantId(),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  statusCode: smallint('status_code').notNull(),
  response: jsonb('response').notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.key] })]);

/**
 * Evidence files (spec → Document storage). Postgres keeps metadata and the SHA-256; the bytes live in private R2.
 * pending: a presigned upload was issued; stored: the bytes were checked and copied into the evidence bucket (then the
 * row never changes again); rejected: the check failed. Never deleted; a wrong file is superseded by a new one.
 */
export const documents = pgTable('documents', {
  id: id(),
  tenantId: tenantId(),
  docType: text('doc_type').notNull(),
  status: text('status').notNull().default('pending'),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  originalFilename: text('original_filename').notNull(),
  evidenceKey: text('evidence_key'),
  rejectedReason: text('rejected_reason'),
  uploadedBy: text('uploaded_by').notNull().default(sql`app_user_id()`),
  storedAt: timestamp('stored_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  unique('documents_tenant_id_id').on(t.tenantId, t.id),
  index('documents_tenant_sha256').on(t.tenantId, t.sha256),
  check('documents_doc_type', sql`${t.docType} in ('accepted_quote', 'receipt', 'invoice', 'customs', 'bill_of_lading', 'photo', 'other')`),
  check('documents_status', sql`${t.status} in ('pending', 'stored', 'rejected')`),
  check('documents_mime', sql`${t.mime} in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic')`),
  check('documents_size', sql`${t.sizeBytes} BETWEEN 1 AND 20971520`),
  check('documents_sha256', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  check('documents_stored', sql`(${t.status} = 'stored') = (${t.evidenceKey} IS NOT NULL AND ${t.storedAt} IS NOT NULL)`),
  check('documents_rejected', sql`(${t.status} = 'rejected') = (${t.rejectedReason} IS NOT NULL)`),
]);

/** Gapless numbers per tenant and series (job orders now; invoices, receipts, vouchers later), never MAX()+1. */
export const tenantCounters = pgTable('tenant_counters', {
  tenantId: tenantId(),
  series: text('series').notNull(),
  last: integer('last').notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.series] })]);

/**
 * A customer's order (spec → Vehicle module, ADR 0001, 0012): what they buy, at what quote, funded by whom. The cut is
 * never typed in; it comes out at completion as quote minus actual cost. Nothing posts to a job without an accepted
 * quote document. The quote-day rate (RMB → NGN) is locked here.
 */
export const jobOrders = pgTable('job_orders', {
  id: id(),
  tenantId: tenantId(),
  number: integer('number').notNull(),
  customerId: uuid('customer_id').notNull(),
  customerKind: text('customer_kind').notNull().default('customer'),
  jobType: text('job_type').notNull(),
  funding: text('funding').notNull().default('customer_funded'),
  fundingReason: text('funding_reason'),
  status: text('status').notNull().default('draft'),
  orderedOn: date('ordered_on').notNull(),
  carPriceMinor: bigint('car_price_minor', { mode: 'bigint' }),
  carPriceCurrency: currency('car_price_currency'),
  quoteRate: numeric('quote_rate', { precision: 18, scale: 6 }),
  quoteRateSource: text('quote_rate_source'),
  quoteRateNote: text('quote_rate_note'),
  landingChargeNgn: bigint('landing_charge_ngn', { mode: 'bigint' }).notNull(),
  acceptedQuoteDocumentId: uuid('accepted_quote_document_id'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  unique('job_orders_tenant_number').on(t.tenantId, t.number),
  unique('job_orders_tenant_id_id').on(t.tenantId, t.id),
  index('job_orders_tenant_status').on(t.tenantId, t.status),
  foreignKey({ name: 'job_orders_customer', columns: [t.tenantId, t.customerId, t.customerKind], foreignColumns: [counterparties.tenantId, counterparties.id, counterparties.kind] }),
  foreignKey({ name: 'job_orders_quote_document', columns: [t.tenantId, t.acceptedQuoteDocumentId], foreignColumns: [documents.tenantId, documents.id] }),
  check('job_orders_customer_kind', sql`${t.customerKind} = 'customer'`),
  check('job_orders_job_type', sql`${t.jobType} in ('car_purchase', 'clearing_only')`),
  check('job_orders_funding', sql`${t.funding} in ('customer_funded', 'emm_funded')`),
  check('job_orders_funding_reason', sql`${t.funding} = 'customer_funded' OR btrim(coalesce(${t.fundingReason}, '')) <> ''`),
  check('job_orders_status', sql`${t.status} in ('draft', 'quote_accepted', 'completed', 'abandoned', 'cancelled')`),
  check('job_orders_number', sql`${t.number} > 0`),
  check('job_orders_landing_charge', sql`${t.landingChargeNgn} >= 0`),
  // A car purchase quotes the car's price in its foreign currency at the locked quote-day rate; clearing-only has neither.
  check('job_orders_quote_shape', sql`CASE ${t.jobType}
    WHEN 'car_purchase' THEN ${t.carPriceMinor} > 0 AND ${t.carPriceCurrency} IS NOT NULL AND ${t.carPriceCurrency} <> 'NGN' AND ${t.quoteRate} > 0 AND ${t.quoteRateSource} IS NOT NULL
    ELSE ${t.carPriceMinor} IS NULL AND ${t.carPriceCurrency} IS NULL AND ${t.quoteRate} IS NULL AND ${t.quoteRateSource} IS NULL END`),
  check('job_orders_quote_rate_source', sql`${t.quoteRateSource} in ('cbn', 'market', 'manual')`),
  check('job_orders_quote_rate_note', sql`${t.quoteRateSource} IS DISTINCT FROM 'manual' OR btrim(coalesce(${t.quoteRateNote}, '')) <> ''`),
  check('job_orders_accepted', sql`(${t.acceptedQuoteDocumentId} IS NULL) = (${t.acceptedAt} IS NULL) AND (${t.status} = 'draft') = (${t.acceptedAt} IS NULL)`),
]);

/** The cars on a job order (one order can cover five cars); a car belongs to one job order at most. */
export const jobOrderVehicles = pgTable('job_order_vehicles', {
  id: id(),
  tenantId: tenantId(),
  jobOrderId: uuid('job_order_id').notNull(),
  vehicleId: uuid('vehicle_id').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('job_order_vehicles_one_job_per_car').on(t.tenantId, t.vehicleId),
  foreignKey({ name: 'job_order_vehicles_job', columns: [t.tenantId, t.jobOrderId], foreignColumns: [jobOrders.tenantId, jobOrders.id] }),
  foreignKey({ name: 'job_order_vehicles_vehicle', columns: [t.tenantId, t.vehicleId], foreignColumns: [vehicles.tenantId, vehicles.id] }),
]);
