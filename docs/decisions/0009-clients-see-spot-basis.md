# 0009 — Clients see the spot basis, not the pool

- Status: accepted (owner decision, 2026-11-15)
- Date: 2026-11-15
- Related: ADR 0008 (pool derived from the ledger), spec → Currency and FX ("Known tension"), `docs/research/2026-11-15-existing-platforms.md`

## Decision
- Every client-facing figure (client portal, reports and PDF packs sent to clients) uses the **spot basis**: a foreign payment is valued at the spot rate on the day it was made, as IAS 21 requires. It is a per-client report setting, and spot is the default for every client.
- The weighted-average **pool basis** (ADR 0008) stays as the firm's internal management view ("the naira it really took") and as the record of what left the foreign cash account. Clients don't see it.
- Both are worked out from stored data. Under the spot basis, a car's cost = foreign amount × spot rate on the payment date, and the gap against the pool's carrying cost is realized FX (7000).

## Consequences
- Every foreign payment must store the spot rate for its date. This arrives with the next slice: the daily reference-rate table (spec → `fx_reference_rates`, global, with source and timestamp), filled by the worker's FX snapshot job, with the user confirming or replacing the pre-filled rate (CLAUDE.md: never hardcode a rate).
- Reports take a basis parameter (`spot` | `pool`); client-facing endpoints only accept `spot` unless the firm changes that client's setting.
- The ledger schema doesn't change; the spot figures are derived. If the accountant later wants spot postings in the books themselves, that's a new ADR.
