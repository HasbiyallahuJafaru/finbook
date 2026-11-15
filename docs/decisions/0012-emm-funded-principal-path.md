# 0012 — EMM-funded (principal) path, and abandoned jobs are always refunded

- Status: accepted (refund ruling by the owner, 2026-11-15)
- Date: 2026-11-15
- Implements: ADR 0001 (funding per job), spec → Vehicle module (EMM-funded, convert to stock) and Accounting core (inventory postings)

## Decision
- **Where an EMM-funded car's cost goes:** 1200 Vehicle inventory – in transit, not 1150. The same posting rules as the agent flow take `funding: 'emm_funded'`: pool payment, supplier invoice, shared or single-car cost. Nothing else changes about them: realized FX, spot rates and the 0006 payment checks behave exactly as for an agent job. 0006's rule "a car's supplier cost reaches its 1150" now accepts 1150 or 1200 (migration 0008).
- **Arrival:** `arriveInYard` moves the car's whole 1200 balance to 1210 Vehicle inventory – in yard.
- **Buyer's deposit:** `stockDeposit`, Dr cash / Cr 2100 Customer deposits, naming the car and the buyer.
- **Sale:** `sellStockCar` posts gross revenue, Cr 4000 at the price. It is paid first from the buyer's deposits (Dr 2100), with the rest receivable (Dr 1100). The car's full landed cost moves Dr 5000 / Cr 1210, by specific identification, so profit is that car's price minus its own cost. A sale is refused while anything is still in transit for the car, or if the deposits exceed the price. NGN prices only for now.
- **Convert to stock:** `convertToStock` is used when a customer abandons a customer-funded job after EMM paid the supplier. Everything capitalized for the car in 1150 moves to 1200. **The customer's funds held (2150) are repaid in full, Dr 2150 / Cr cash. A deposit is never forfeited** (owner ruling, 2026-11-15). From then on the car goes the stock way: arrival, then sale.
- **A car is a job or stock, never both.** The database reads each car's mode from its own ledger history, because job_orders doesn't exist yet. The agent side is 1150, 2150, 4100 and 4200; the principal side is 1200, 1210, 2100, 4000 and 5000.
  - An entry can't touch both sides for one car.
  - An agent job takes no principal postings until it is converted.
  - A car with any principal history takes no agent postings.
  - Convert to stock is the one crossing. It works only on an open job (no 4100/4200 yet), and only for a car EMM paid the supplier for: a clearing-only job is the customer's own car. It must move the whole 1150 and repay the whole 2150 in cash, nothing else.
  - Mode is read from live entries only, meaning neither reversed nor a reversal. A mistake corrected by reversal, such as a convert posted in error or a cost posted with the wrong funding, leaves the car as it was.
- **Database guards** (migration 0008, `assert_inventory_entry`, run inside `post_journal_entry` like the 0006/0007 checks; EXECUTE revoked from PUBLIC):
  - a car's 1150, 1200 and 1210 never go below zero, its 2150 and each buyer's 2100 never go into debit. This applies to reversals too, so a correction undoes later steps first: the sale, then the arrival, then the cost;
  - every 1200/1210 line names its car, and every 2100 line its car and buyer;
  - inventory is paid for only from the pool (1010), payables (2000), cash (1000), a converted job's costs (1150) or transit (1200);
  - a car leaves 1200 only by moving its whole in-transit cost to 1210 in the same entry;
  - a car leaves 1210 only in a sale that moves its whole yard cost to 5000, books revenue (4000) naming the car in the same entry, and leaves nothing in transit;
  - apart from the zero and naming rules, reversals mirror exactly and are exempt.
- **Deposits belong to their buyer.** A sale applies only that buyer's deposits. `refundStockDeposit` pays a buyer back, never more than they paid.

## Why
- Principal accounting under IFRS 15: when EMM controls the car before the sale, revenue is gross and the car is inventory at cost. Customer-funded jobs stay agent accounting (ADR 0001).
- Making the database refuse any partial move keeps each car's inventory value equal to its own costs, which is what specific identification needs and what an auditor re-performs.
- Refunding instead of forfeiting is the owner's business practice. It narrows the spec's "applies the deposit-forfeit or refund terms written on the job order": there is no forfeit path and no forfeit income account.

## Consequences
- The spec's Vehicle module line on forfeit terms needs updating in the Claude Doc (owner).
- **Not enforced yet; needs job_orders (endpoints slice):**
  - which funding a car has, so a customer-funded car's cost can't land on 1200 or the reverse;
  - "a reason and a firm reviewer's approval before any supplier payment" on an EMM-funded job;
  - "a supplier payment on a job with no customer receipt is blocked until approved as emm_funded";
  - funding locked at the first supplier payment.
- **Proof of a supplier purchase is approximate.** "EMM paid the supplier" means a live pool payment or supplier invoice names the car. A clearing-only job with, say, an RMB freight charge tagged to the car would pass. The real test is the job type, which comes with job_orders.
- **"Never forfeited" is enforced only in a conversion.** This was accepted by the ledger audit on conditions. No endpoint may post a 2150 debit outside the posting rules before this is closed. Closing it is a blocker for the endpoint that ships job_orders or a checked `source_type`. On an open job, a 2150 debit paired with income (Dr 2150 / Cr 4200, or Cr an expense) looks the same to the database as part of a completion. Telling them apart needs job_orders (a completion belongs to a completed job) or a checked `source_type`. Until then the posting rules are the only guard, and an exception report should flag any 2150 debit outside completion or refund.
- **Convert to stock needs a firm reviewer's approval** (owner ruling, 2026-11-15) and appears on the exception report. It isn't enforced yet, because approvals arrive with job_orders. The database must refuse a conversion without an approved request then, and no endpoint may post one before.
- **Cost of sales is on the pool basis.** Clients see the spot basis (ADR 0009), so a stock car's gross profit in client reports must use spot cost (`spotCarCost`). That belongs to the reports slice and needs the accountant to confirm it for principal revenue.
- **A sale only needs some revenue for the car.** The sale guard requires a 4000 line for the car but doesn't check its size, so a token price could act as a write-off. Write-downs need their own entry type with approval.
- Inventory isn't revalued (non-monetary, ADR 0011). No inventory write-down path yet: a car can only leave the yard by a sale. A write-down (net realizable value below cost) needs its own entry type when an accountant asks for one.
- RMB-priced stock sales would need the quote-day rate and an FX-on-sale line, like `completeAgentJob`; not built.
