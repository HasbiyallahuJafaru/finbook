# 0001 — Accounting treatment is set per job, agent by default

- Status: accepted (pending accountant sign-off)
- Date: 2026-11-14

## Context
EMM's Shop buys cars in China for customers who have already paid, and takes a cut that varies by job. Very rarely, EMM's pays for a car before the customer does, or keeps a car a customer abandoned.

## Decision
- `job_orders.funding` is either `customer_funded` (default) or `emm_funded`.
- `customer_funded` → agent accounting (IFRS 15): customer money sits in 2150 Customer funds held, costs go to 1150 Recoverable job costs, and revenue is only the cut: 4100 car markup at the quote-day rate, plus 4200 landing charge minus actual landed cost. The car never enters inventory.
- `emm_funded` → principal accounting: the car goes to 1200/1210 inventory, and the sale posts gross revenue and cost of sales. This requires a reason and a firm reviewer's approval before any supplier payment.
- A supplier payment on a job with no customer receipt is blocked until the job is approved as `emm_funded`.
- Funding locks at the first supplier payment. Changing it later needs a reversal plus approval. Abandoned jobs use "convert to stock".
- In v1, EMM-funded is an exception path with no stock screens. The ledger supports it fully.

## Consequences
Reported revenue is far below the gross car sales shown in the old workbook. An accountant must confirm the agent treatment per tenant before go-live.
