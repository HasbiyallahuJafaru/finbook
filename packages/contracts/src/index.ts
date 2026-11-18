// Zod schemas shared by web and api (spec → Architecture). Money fields are strings of minor units plus a currency;
// dates are ISO YYYY-MM-DD.
import { z } from 'zod';
import { VinInput } from './vin.ts';

export { VinInput, vinProblem, vinStatus } from './vin.ts';

export const ROLES = ['firm_admin', 'firm_accountant', 'firm_reviewer', 'client_owner', 'client_staff', 'client_viewer'] as const;
export const Role = z.enum(ROLES);

/** X-Tenant-Id: firm staff name the client they act for; client users may omit it and use their active org. */
export const TenantIdHeader = z.uuid();

/** GET /me: who the caller is in the tenant they are acting for, and what they may do there. */
export const MeResponse = z.object({
  tenantId: z.uuid(),
  legalName: z.string(),
  userId: z.string(),
  role: Role,
  permissions: z.array(z.string()),
});
export type MeResponse = z.infer<typeof MeResponse>;

/** Idempotency-Key on every write: a client-made id (a UUID is ideal), reused verbatim on a retry. */
export const IdempotencyKeyHeader = z.string().trim().min(8).max(200).regex(/^[\x21-\x7e]+$/);

const optionalText = z.string().trim().min(1).max(200).optional();

export const CounterpartyKind = z.enum(['supplier', 'agent', 'customer']);
export const CreateCounterparty = z.strictObject({
  kind: CounterpartyKind,
  name: z.string().trim().min(1).max(200),
  phone: optionalText,
  email: z.email().max(200).optional(),
  tin: optionalText,
});
export type CreateCounterparty = z.infer<typeof CreateCounterparty>;
export const Counterparty = CreateCounterparty.extend({ id: z.uuid(), phone: z.string().nullable(), email: z.string().nullable(), tin: z.string().nullable() });
export type Counterparty = z.infer<typeof Counterparty>;
export const ListCounterpartiesQuery = z.strictObject({ kind: CounterpartyKind.optional() });

const isoDate = z.iso.date(); // YYYY-MM-DD from the date picker; never parsed from free text
export const VehicleDirection = z.enum(['import', 'export', 'local']);
export const VehicleStatus = z.enum(['purchased', 'in_transit', 'at_port', 'in_yard', 'reserved', 'sold', 'delivered', 'written_off', 'returned']);
export const CreateVehicle = z.strictObject({
  vin: VinInput,
  make: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(100),
  year: z.int().min(1950).max(2100),
  colour: optionalText,
  mileage: z.int().min(0).max(5_000_000).optional(),
  direction: VehicleDirection.default('import'),
  purchaseDate: isoDate.optional(),
});
export type CreateVehicle = z.infer<typeof CreateVehicle>;
export const Vehicle = z.object({
  id: z.uuid(), vin: z.string(), vinStatus: z.enum(['ok', 'vin_needs_correction']), vinProblem: z.string().nullable(),
  make: z.string(), model: z.string(), year: z.int(), colour: z.string().nullable(), mileage: z.int().nullable(),
  direction: VehicleDirection, status: VehicleStatus, purchaseDate: isoDate.nullable(), soldDate: isoDate.nullable(),
});
export type Vehicle = z.infer<typeof Vehicle>;
export const ListVehiclesQuery = z.strictObject({ status: VehicleStatus.optional(), vinStatus: z.enum(['ok', 'vin_needs_correction']).optional() });

/** Money in minor units (kobo, fen) as a string, so it survives JSON as an exact bigint (CLAUDE.md → Money). */
export const MinorUnits = z.string().regex(/^(0|[1-9]\d{0,17})$/, 'a whole number of minor units, as a string');
/** A rate as a decimal string, up to 6 places, positive (NUMERIC(18,6); parsed by @app/money parseRate). */
export const RateString = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'a decimal rate with up to 6 places').refine((s) => /[1-9]/.test(s), 'rate must be positive');
const ForeignCurrency = z.string().regex(/^[A-Z]{3}$/).refine((c) => c !== 'NGN', 'the car price is quoted in a foreign currency');

export const DocumentType = z.enum(['accepted_quote', 'receipt', 'invoice', 'customs', 'bill_of_lading', 'photo', 'other']);
export const DocumentMime = z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/heic']);
export const DocumentStatus = z.enum(['pending', 'stored', 'rejected']);
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Step 1 of an upload: say what is coming; the answer carries a 10-minute presigned PUT for exactly that file. */
export const CreateUpload = z.strictObject({
  docType: DocumentType,
  mime: DocumentMime,
  sizeBytes: z.int().min(1).max(MAX_DOCUMENT_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'lower-case hex SHA-256 of the file'),
  filename: z.string().trim().min(1).max(255),
});
export const Document = z.object({
  id: z.uuid(), docType: DocumentType, status: DocumentStatus, mime: DocumentMime, sizeBytes: z.int(), sha256: z.string(),
  filename: z.string(), rejectedReason: z.string().nullable(), uploadedBy: z.string(),
});
export type Document = z.infer<typeof Document>;
export const UploadTicket = z.object({
  document: Document,
  upload: z.object({ method: z.literal('PUT'), url: z.url(), headers: z.record(z.string(), z.string()), expiresAt: z.iso.datetime() }),
});
export type UploadTicket = z.infer<typeof UploadTicket>;
export const DownloadTicket = z.object({ url: z.url(), expiresAt: z.iso.datetime() });
export type DownloadTicket = z.infer<typeof DownloadTicket>;

export const JobType = z.enum(['car_purchase', 'clearing_only']);
export const Funding = z.enum(['customer_funded', 'emm_funded']);
export const JobStatus = z.enum(['draft', 'quote_accepted', 'completed', 'abandoned', 'cancelled']);
export const QuoteRateSource = z.enum(['cbn', 'market', 'manual']);
/** A question about how we book something the client recorded, raised by the database as the entry commits; a firm sign-off answers it, and never unlocks a posting (ADR 0016). */
export const FlagKind = z.enum(['emm_funded', 'converted_to_stock', 'posted_before_quote', 'supplier_cost_not_covered', 'cost_after_completion', 'cost_credited', 'negative_cut', 'funds_after_completion']);

export const CreateJobOrder = z.strictObject({
  customerId: z.uuid(),
  jobType: JobType,
  funding: Funding.default('customer_funded'),
  fundingReason: z.string().trim().min(1).max(500).optional(),
  orderedOn: isoDate,
  carPrice: z.strictObject({ amountMinor: MinorUnits, currency: ForeignCurrency }).optional(),
  quoteRate: z.strictObject({ rate: RateString, source: QuoteRateSource, note: z.string().trim().min(1).max(500).optional() }).optional(),
  landingChargeNgn: MinorUnits,
}).superRefine((j, ctx) => {
  const purchase = j.jobType === 'car_purchase';
  if (purchase !== (j.carPrice !== undefined)) ctx.addIssue({ code: 'custom', path: ['carPrice'], message: purchase ? 'a car purchase needs the car price' : 'clearing only has no car price' });
  if (purchase !== (j.quoteRate !== undefined)) ctx.addIssue({ code: 'custom', path: ['quoteRate'], message: purchase ? 'a car purchase needs the quote-day rate' : 'clearing only has no quote rate' });
  if (j.quoteRate?.source === 'manual' && !j.quoteRate.note) ctx.addIssue({ code: 'custom', path: ['quoteRate', 'note'], message: 'a manual rate needs a note' });
  if (j.funding === 'emm_funded' && !j.fundingReason) ctx.addIssue({ code: 'custom', path: ['fundingReason'], message: 'EMM-funded needs a reason' });
});
export type CreateJobOrder = z.infer<typeof CreateJobOrder>;
export const JobOrder = z.object({
  id: z.uuid(), number: z.int(), customerId: z.uuid(), jobType: JobType, funding: Funding, fundingReason: z.string().nullable(),
  status: JobStatus, orderedOn: isoDate,
  carPrice: z.object({ amountMinor: MinorUnits, currency: z.string() }).nullable(),
  quoteRate: z.object({ rate: z.string(), source: QuoteRateSource, note: z.string().nullable() }).nullable(),
  landingChargeNgn: MinorUnits, acceptedQuoteDocumentId: z.uuid().nullable(),
  /** Each car with its own quoted price (car purchases; null on clearing-only), in the job's car currency, and its own landing charge in kobo. */
  vehicles: z.array(z.object({ vehicleId: z.uuid(), carPriceMinor: MinorUnits.nullable(), landingChargeNgn: MinorUnits })),
  /** Flags the database raised as entries committed, each with its firm sign-off once given (ADR 0016). */
  flags: z.array(z.object({
    id: z.uuid(), kind: FlagKind, vehicleId: z.uuid(), entryId: z.uuid(), raisedAt: z.string(),
    signOff: z.object({ reason: z.string(), signedBy: z.string(), signedAt: z.string() }).nullable(),
  })),
});
export type JobOrder = z.infer<typeof JobOrder>;
export const ListJobOrdersQuery = z.strictObject({ status: JobStatus.optional() });
/**
 * A car on a car purchase needs its own quoted price; a clearing-only car has none. Every car has its own landing charge; the
 * cars' charges add up to the job's when the quote is accepted (owner 2026-11-17; the database checks all three).
 */
export const AddJobVehicle = z.strictObject({ vehicleId: z.uuid(), carPriceMinor: MinorUnits.optional(), landingChargeNgn: MinorUnits });
export const AcceptQuote = z.strictObject({ documentId: z.uuid() });
export const SignOffFlag = z.strictObject({ flagId: z.uuid(), reason: z.string().trim().min(1).max(500) });

/**
 * One business event to post (ADR 0017; owner 2026-11-17: one route, a typed body). The request carries the facts only: the
 * customer, funding, history and amounts already held come from the database, the rule in packages/ledger builds the lines,
 * and the entry type comes from the rule. More types join this union batch by batch.
 */
const postingFacts = { entryDate: isoDate, memo: z.string().trim().min(1).max(500).optional(), evidenceDocumentId: z.uuid().optional() };
/**
 * The day's spot (reference) rate, confirmed by the user: the stored CBN rate pre-fills it (cbn, checked by the database), or
 * they type another with a note saying why (manual). Clients see the spot basis (ADR 0009, 0010).
 */
const Spot = z.strictObject({ rate: RateString, source: z.enum(['cbn', 'manual']), note: z.string().trim().min(1).max(500).optional() });
// A foreign-currency posting needs its document: the rate is provable only from it (CLAUDE.md; owner 2026-11-17).
const foreign = { currency: ForeignCurrency, amountMinor: MinorUnits };
const foreignFacts = { ...postingFacts, evidenceDocumentId: z.uuid() };
export const CreatePosting = z.discriminatedUnion('type', [
  /** The job's customer pays towards a car: held in 2150 until the job completes. */
  z.strictObject({ type: z.literal('customer_receipt'), vehicleId: z.uuid(), amountNgn: MinorUnits, ...postingFacts }),
  /** Customer funds paid back from what is held for the car (an overpayment, or an abandoned job: never forfeited). */
  z.strictObject({ type: z.literal('customer_refund'), vehicleId: z.uuid(), amountNgn: MinorUnits, ...postingFacts }),
  /** The customer pays what they owe (1100) after the car's completion or sale. */
  z.strictObject({ type: z.literal('receivable_receipt'), vehicleId: z.uuid(), amountNgn: MinorUnits, ...postingFacts }),
  /** Foreign currency bought for naira at the rate on the bank's or BDC's receipt: it joins the weighted-average pool (1010). */
  z.strictObject({ type: z.literal('currency_purchase'), ...foreign,
    rate: z.strictObject({ rate: RateString, source: z.enum(['bank_receipt', 'bdc_receipt', 'manual']), note: z.string().trim().min(1).max(500).optional() }), ...foreignFacts }),
  /** The China supplier paid from the pool for one car: the car carries the pool's average cost. */
  z.strictObject({ type: z.literal('pool_payment'), vehicleId: z.uuid(), ...foreign, spot: Spot, ...foreignFacts }),
  /** A supplier's invoice for one car at the invoice rate: the car's cost goes up and a foreign payable is owed. */
  z.strictObject({ type: z.literal('supplier_invoice'), vehicleId: z.uuid(), supplierId: z.uuid(), ...foreign, invoiceRate: RateString, spot: Spot, ...foreignFacts }),
  /** (Part of) a supplier's invoice for one car paid from the pool: the gap against the booked cost is realized FX (7000). */
  z.strictObject({ type: z.literal('supplier_settlement'), vehicleId: z.uuid(), supplierId: z.uuid(), ...foreign, spot: Spot, ...foreignFacts }),
]);
export type CreatePosting = z.infer<typeof CreatePosting>;
export const Posting = z.object({
  entryId: z.uuid(), type: z.string(), entryDate: isoDate, memo: z.string(),
  lines: z.array(z.object({
    account: z.string(), debitNgn: MinorUnits, creditNgn: MinorUnits, currency: z.string(), amountMinor: MinorUnits,
    vehicleId: z.uuid().nullable(), counterpartyId: z.uuid().nullable(),
  })),
  /** Flags the database raised as this entry committed, for a firm reviewer (ADR 0016). */
  flags: z.array(z.object({ id: z.uuid(), kind: FlagKind, vehicleId: z.uuid() })),
});
export type Posting = z.infer<typeof Posting>;
/** Evidence for an entry that posted without it (owner 2026-11-17: evidence pending until attached; a document backing several entries is listed for review). */
export const AttachEvidence = z.strictObject({ documentId: z.uuid() });
export const EntryEvidence = z.object({ entryId: z.uuid(), documentId: z.uuid(), attachedBy: z.string(), attachedAt: z.string() });
export type EntryEvidence = z.infer<typeof EntryEvidence>;
