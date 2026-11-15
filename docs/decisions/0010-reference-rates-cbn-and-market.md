# 0010 — Reference rates: CBN and a market feed

- Status: accepted (owner chose both, 2026-11-15)
- Date: 2026-11-15
- Closes: spec → Open decisions, "Which live provider fills the suggested rate on forms"

## Decision
The worker stores two daily rates per currency (CNY, USD) in `fx_reference_rates`:

| Source | Where it comes from | Used for |
| --- | --- | --- |
| `cbn` | CBN's own JSON feed, `https://www.cbn.gov.ng/api/GetAllExchangeRates` (fields `currency`, `ratedate`, `centralrate`; "YUAN/RENMINBI" and "US DOLLAR"). We store the **central rate**. | The reference: month-end revaluation (7100), pre-filling the spot rate (the basis clients see, ADR 0009), and the "rate more than 2% from reference" exception |
| `market` | exchangerate-api.com's free endpoint, `https://open.er-api.com/v6/latest/{CNY,USD}` (daily, no key). It's a mid-market rate, not the BDC street rate. Its terms require the credit "Rates By Exchange Rate API" wherever its rates are shown. | Only pre-filling the rate-paid field on forms |

- A pre-filled rate is a suggestion. The user confirms it or replaces it with the rate on the receipt (CLAUDE.md: never hardcode a rate).
- Every foreign line that needs a spot rate records where it came from: `cbn` (the database checks it equals the CBN central rate last published on or before the entry date, at most 7 days earlier, latest revision) or `manual` (needs a note, e.g. "CBN not yet published"). CBN doesn't publish at weekends, hence "on or before"; a feed outage longer than a week forces manual rates with notes rather than silently reusing an old one.
- To re-perform a `cbn` spot rate, take the latest CBN revision for that currency dated on or before the entry date (within 7 days) and fetched before the entry was created (`fetched_at` ≤ `created_at`).
- The snapshot runs daily at 10:30 Africa/Lagos as a BullMQ job scheduler (`fx-snapshot-daily`), with retries and backoff. A source that fails makes the job fail (and Sentry report it); nothing is guessed or carried over.
- The worker writes through its own login, `finbook_rates`: it can add and read reference rates and nothing else (no tenant data, not a superuser).
- Rates are append-only. A wrong rate is corrected by a higher `revision` for the same day and source; readers take the highest revision. When CBN restates a day, the snapshot stores the new figure as the next revision.
- Feed numbers never pass through a float: they're read as their exact JSON source text and rounded half-up to 6 decimals (`roundRate` in `packages/money`).

## Why
- CBN is the official source and publishes the yuan directly, so no cross rate is needed.
- There is no parallel-market (BDC) feed with an API; the street rate only ever comes from the receipt. A mid-market feed is still a useful starting point for the form.

## Consequences
- `RATES_DATABASE_URL` (the `finbook_rates` login) must be set on the worker; `FINBOOK_RATES_DB_PASSWORD` on the migrate service sets its password.
- The CBN endpoint is undocumented and returns the full history (several MB). If CBN changes or removes it, the job fails loudly; switch to a paid wrapper of the CBN page then.
- The web app must show "Rates By Exchange Rate API" next to any market-fed suggestion.
