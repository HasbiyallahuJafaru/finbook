// Daily reference-rate snapshot (ADR 0010). Two sources, stored side by side in fx_reference_rates:
//  - cbn: the CBN central rate, the reference for revaluation, the spot pre-fill and rate exceptions;
//  - market: a mid-market feed (exchangerate-api.com; its terms require "Rates By Exchange Rate API" wherever its
//    rates are shown), used only to pre-fill the rate-paid field. Users always confirm or replace a pre-filled rate.
// Rates never pass through a float: JSON numbers are kept as their source text and rounded by packages/money.
import type pg from 'pg';
import { formatRate, roundRate } from '@app/money';

export type Currency = 'CNY' | 'USD';
export type RateRow = { rateDate: string; currency: Currency; rate: string; source: 'cbn' | 'market' };

export const CBN_URL = 'https://www.cbn.gov.ng/api/GetAllExchangeRates';
export const marketUrl = (currency: Currency) => `https://open.er-api.com/v6/latest/${currency}`;
const CBN_NAMES: Record<string, Currency> = { 'YUAN/RENMINBI': 'CNY', 'US DOLLAR': 'USD' };

/** JSON.parse, but every number comes back as its exact source text (Node 24 reviver context). */
export const parseExact = (text: string): unknown =>
  JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => (typeof value === 'number' && context?.source ? context.source : value));

const record = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('unexpected rate feed shape');
  return v as Record<string, unknown>;
};
const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v === '') throw new Error(`rate feed is missing ${what}`);
  return v;
};

/** CBN feed: an array of { currency, ratedate, centralrate, ... }. Keeps the latest date per currency we use. */
export function parseCbn(body: string): RateRow[] {
  const rows = parseExact(body);
  if (!Array.isArray(rows)) throw new Error('unexpected CBN feed shape');
  const latest = new Map<Currency, RateRow>();
  for (const r of rows.map(record)) {
    const currency = CBN_NAMES[String(r.currency)];
    if (!currency) continue;
    const rateDate = text(r.ratedate, 'ratedate').slice(0, 10);
    // ISO only: a day-first or month-first date would land the rate on the wrong day.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) throw new Error(`CBN ratedate is not an ISO date: ${rateDate}`);
    const row: RateRow = { rateDate, currency, rate: formatRate(roundRate(text(r.centralrate, 'centralrate'))), source: 'cbn' };
    const seen = latest.get(currency);
    if (!seen || row.rateDate > seen.rateDate) latest.set(currency, row);
  }
  if (latest.size === 0) throw new Error('CBN feed has no CNY or USD rate');
  return [...latest.values()];
}

/** Market feed: { result, time_last_update_utc, rates: { NGN } } with `currency` as the base. NGN per unit of `currency`. */
export function parseMarket(body: string, currency: Currency): RateRow {
  const r = record(parseExact(body));
  if (r.result !== 'success') throw new Error(`market feed returned ${String(r.result)}`);
  const rateDate = new Date(text(r.time_last_update_utc, 'time_last_update_utc')).toISOString().slice(0, 10);
  return { rateDate, currency, rate: formatRate(roundRate(text(record(r.rates).NGN, 'the NGN rate'))), source: 'market' };
}

/** Fetch both sources. A failing source throws, so the job retries and Sentry sees it; nothing is guessed. */
export async function fetchRates(get: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<RateRow[]> {
  const body = async (url: string) => {
    const res = await get(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${url} answered ${String(res.status)}`);
    return res.text();
  };
  return [...parseCbn(await body(CBN_URL)), parseMarket(await body(marketUrl('CNY')), 'CNY'), parseMarket(await body(marketUrl('USD')), 'USD')];
}

/**
 * Insert as the finbook_rates login. Same rate already stored for that day and source: skipped. A different rate
 * (CBN restated the day): stored as the next revision, so the history of what was published stays visible.
 */
export async function storeRates(db: pg.ClientBase, rows: readonly RateRow[]): Promise<number> {
  let inserted = 0;
  for (const r of rows) {
    const latest = (await db.query<{ rate: string; revision: number }>(
      'SELECT rate::text AS rate, revision FROM fx_reference_rates WHERE rate_date = $1 AND currency = $2 AND source = $3 ORDER BY revision DESC LIMIT 1',
      [r.rateDate, r.currency, r.source])).rows[0];
    if (latest?.rate === r.rate) continue;
    await db.query('INSERT INTO fx_reference_rates (rate_date, currency, rate, source, revision) VALUES ($1, $2, $3, $4, $5)',
      [r.rateDate, r.currency, r.rate, r.source, (latest?.revision ?? 0) + 1]);
    inserted += 1;
  }
  return inserted;
}
