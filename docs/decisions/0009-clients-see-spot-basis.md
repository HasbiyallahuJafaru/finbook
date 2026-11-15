# 0009 — Clients see the spot basis, not the pool

- Status: accepted (owner decision, 2026-11-15)
- Date: 2026-11-15
- Related: ADR 0008 (pool derived from the ledger), spec → Currency and FX ("Known tension"), `docs/research/2026-11-15-existing-platforms.md`

## Decision
- Every client-facing figure (client portal, reports and PDF packs sent to clients) uses the **spot basis**: each foreign transaction is valued at the spot rate on its own transaction date, as IAS 21 requires. A car paid straight from the pool uses the spot rate on the payment date; a car invoiced by a supplier uses the spot rate on the invoice date (then the payment settles the payable, and the gap is realized FX). It is a per-client report setting, and spot is the default for every client.
- The weighted-average **pool basis** (ADR 0008) stays as the firm's internal management view ("the naira it really took") and as the record of what left the foreign cash account. Clients don't see it.
- Both are worked out from stored data. Under the spot basis, a car's cost = foreign amount × spot rate on its transaction date (`spotCarCost` in `packages/ledger`); the gap against the firm's booked cost is FX.

## Consequences
- Every pool payment and supplier invoice stores the spot rate for its date and where it came from (`spot_source`: `cbn`, checked against the stored CBN rate, or `manual` with a note). Rates come from `fx_reference_rates`, filled daily by the worker (ADR 0010); the user confirms or replaces the pre-filled rate (CLAUDE.md: never hardcode a rate).
- Reports take a basis parameter (`spot` | `pool`); client-facing endpoints only accept `spot` unless the firm changes that client's setting.
- The ledger schema doesn't change; the spot figures are derived. If the accountant later wants spot postings in the books themselves, that's a new ADR.
