# 0020: Per-car profitability report, on the spot or pool basis

- Status: accepted (owner asked for it, 2026-11-18); the figures' definitions need the accountant's sign-off
- Date: 2026-11-18
- Implements: spec → Reports (per-car profitability), ADR 0009 (reports take a basis). `packages/reports`, `GET /reports/car-profit`.

## Context
The spec lists per-car profitability as a self-serve report: each sold car's sale price, cost by component, gross profit and margin. ADR 0009 says clients see the spot basis (each foreign cost at the spot rate on its own day) and the firm can also see the pool basis (what the pool really spent). The spec's phase table puts all reports in phase 4. The owner asked for this one now (2026-11-18), as part of the phase 2 gate.

## Decision
The report has one row for each car whose completion (`job_completion`) or stock sale (`stock_sale`) is dated in the range and still stands on the end date. All figures are kobo from journal lines only. The response carries `asOfSeq`: the tenant's hash-chain position the report was read at, so a later posting (even a backdated one) shows the figures may have moved. A range covers at most 366 days.

- **Billed**: what the sale entry charged (its debits on 2150, 2100 and 1100).
- **Car cost**: the car's foreign supplier cost posted *before the sale in posting order* (hash-chain `seq`), whatever its date. Entries are dated freely, and the sale cleared what was posted before it. On the pool basis this is the booked naira: the pool's cost, or the invoice rate for an invoiced car. On the spot basis it is each line at its stored spot rate.
- **Landed cost**: what the sale cleared (1150 credited, or 5000 debited) minus the booked car cost.
- **Trading profit**: the sale entry's lines on 4000, 4100, 4200 and 5000.
  - On a job (markup plus clearing margin) it is fixed at the quote rate, so it is the same on both bases.
  - On a stock car, the spot basis takes the gap out of cost of sales.
- **FX** has three named parts:
  - **quote FX**: the sale entry's 7000 line, on the spot basis measured against the spot cost;
  - **pool vs spot**: spot cost minus booked cost, zero on the pool basis;
  - **other FX**: the car's other 7000 lines, such as a supplier settlement.
- **Net profit**: every P&L line naming the car (4000, 4100, 4200, 5000, 7000) dated up to the end date. It is the same on both bases.
- **Other profit**: net minus trading minus FX. It is P&L on the car outside the sale entry that is not the car's own FX. The main case is another completion or sale still standing; every line of that entry, its FX included, counts here. It is zero unless a reviewer should look.
- **One statement, one snapshot**: the ledger position comes back on the same query as the lines, so `asOfSeq` always matches the figures.
- **Every row foots twice**:
  - billed = car cost + landed cost + trading profit + quote FX;
  - net = trading profit + FX + other profit.
- **Margin**: trading profit divided by billed, in basis points, rounded half up. It is null when nothing was billed.

Client roles get the spot basis only (403 on `basis=pool`). Firm roles get both, through `firm_access` and with a second factor. `client_viewer` gets no report.

## Consequences
- **The pool figures can be worked out from a client's spot report.** Spot cost minus "pool vs spot" is the booked cost. Even without that column, billed minus landed cost minus net profit gives it whenever the car has no other FX. That is because the books themselves, and so net profit, are at pool. Hiding pool from clients would need spot postings in the books (ADR 0009 → Consequences, and the open stock-car question in `docs/PROGRESS.md`). For the owner: confirm that the spot report naming the gap is acceptable.
- **For the owner:** `client_staff` can read this report (`reports.read` = the readers of the books' detail). Should margins be for `client_owner` only?
- **Cost by component** (per cost type) is not split out yet. Each component is one click away in `cost_allocations`. Add the breakdown when the web report needs it.
- **No per-client basis setting yet** (ADR 0009), so clients are always on spot.
- **The row sits in the sale's period.** FX or a correction dated after the range's end falls in no per-car row. A completion reversed and redone in a later period shows the new cut there in full, while that period's P&L carries the difference. Per-car totals across periods therefore need not tie to the P&L. A "post-sale adjustments" view would close the gap when the monthly pack needs it.
- **Found while building this, for the owner:**
  - A completion can be dated before the reversal of the car's previous completion. The report then shows the first cut as other profit, which is visible but not flagged.
  - A cost posted to 1200 after a stock car's sale stays on inventory.
  - A completion can be dated before the payment it clears, leaving 1150 credited with no cost behind it on those days.
  - Should each of these post and be flagged on `job_order_exceptions`?
- **For the accountant:**
  - This is option (i) of the open stock-car question: books at pool, client reports at spot, with the gap shown as FX.
  - Is "trading profit" the right name for markup plus clearing margin on an agent job?
