# 0002 — FX: actual rate on costs, quote-day rate on selling price

- Status: accepted (IAS 21 treatment pending accountant sign-off)
- Date: 2026-11-14

## Decision
- NGN is the functional currency. RMB and USD amounts are stored alongside.
- Every foreign cost line stores the rate actually paid, its source and evidence. A live rate only pre-fills the form.
- Foreign cash is a weighted-average pool per currency.
- The customer's RMB selling price is converted at the quote-day rate, locked on the job order. The gap against the rate actually paid is FX gain/loss (7000), never margin.
- Month-end revaluation of monetary items posts to 7100 and auto-reverses.

## Open
Under IAS 21, statutory statements may need inventory (principal jobs only) at the spot rate rather than the pool cost. Both can be derived from stored data, so this is a report-basis setting, not a schema change.
