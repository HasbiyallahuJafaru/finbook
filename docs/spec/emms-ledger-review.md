# EMM's Shop ledger review

Source of truth is the "EMM's Shop ledger review" tab of the build-spec Claude Doc (exported 2026-11-14). Source workbook: `EMMS_SHOP_LEDGER.xlsx`.

The workbook's container costing is sound: the three C4 cost sheets tie to the cashbook within ₦0.01 for every cost type. Its profit figures can't be relied on, though. The worst case is rows 25–28, which would show ₦211.9m of "profit" because they subtract a blank landed cost from the full selling price.

The review covers all 7 sheets and 26 sales-log rows. Every figure below was recomputed from the file, not read off the sheet.

## Findings

| # | Where | What's wrong | Effect | Fixed in the system by |
| --- | --- | --- | --- | --- |
| 1 | SALES&PROFIT LOG P25:P28 | Profit = selling price − landed cost, and landed cost is blank | ₦211,874,868.30 reported as profit, which is the whole selling price | Profit calculated from the ledger. A car can't be sold with its costs missing. |
| 2 | SALES&PROFIT LOG P3:P28 | Three different profit formulas: N−O (rows 3–9), O−N (row 10, sign reversed), K−O (rows 25–28), and none at all in rows 11–24 | Profit can't be compared from row to row | One calculation, run by the system |
| 3 | Columns N and O | "LANDING COST" and "LANDED COST" sit side by side with no label explaining them. The owner confirms N is the amount charged and O is the actual cost. | Nobody can say what column P measures | Separate, clearly labelled fields for amount charged and cost incurred |
| 4 | Column M (margin) | Additional cost (column G) isn't deducted, except in L24 | Margin overstated by ₦2,881,511.40 across 10 rows | China-side extras are capitalized into the car's cost |
| 5 | Rows 3–5 | Cost and selling price converted at different rates. Row 5: 200.14 vs 219.52 | About ₦2.56m of row 5's ₦3.86m margin is the rate gap | FX on sale reported on its own line |
| 6 | G5 | The additional cost implies a rate of 402.20 against about 200 everywhere else | Probably overstated by about ₦120k (looks doubled) | Rate-outlier exception report |
| 7 | A3:A5, A9, A12 (and the same rows in JOB ORDER) | These are stored as real dates, read month-first. The other dates are typed text. Read day-first, the log runs in order: 6 Mar, 16 Apr, 7 May, 24 May, 3 Jun, 14 Aug. | Sales land in the wrong month in any monthly P&L | Date picker, ISO storage |
| 8 | O9, O12, rows 15–28 | Landed cost missing on 16 sold cars | Their profit can't be calculated | "Costs pending" flag and an exception report |
| 9 | VEHICLE COST SHEET, Song Plus 2025 | Two cost sheets for the same car (Mallam Shehu): ₦8,206,111.34 in C4 and ₦9,206,111.02 separately. The log uses ₦9,206,111.34. The ₦1m gap is a CPH extra fee that isn't in the cashbook. | Possibly ₦1m of cost with no payment behind it | Container reconciliation, evidence required on every cost |
| 10 | Shared cost lines (e.g. B9, B14, B17) | Thirds typed as 833,333.333, which don't add back to the 2,499,999.99 paid | Fractions of a kobo, so totals don't reconcile | Allocation in kobo with a remainder line |
| 11 | SALES&PROFIT LOG B6, B9, B23, B28 | B6 and B9 fail the VIN check digit, B23 has 16 characters, B28 contains the letter O | The car can't be matched to customs or registration papers | VIN validation at entry |
| 12 | CASHBOOK | No dates, no opening or closing balance, no receipts side, no bank account, and only one container's payments (₦21,709,262.75) | It can't be reconciled to the bank, so it isn't really a cashbook | Payment vouchers, receipts, bank accounts, monthly bank reconciliation |
| 13 | TRACKER | Empty | Deposits received and balances owed are unknown | Customer receipts and an ageing report |
| 14 | Rows 11, 13, 14, 24 (clearing-only jobs) | Only cost is recorded, no revenue | Clearing income is missing from the P&L | "Clearing only" job type with its own invoice |
| 15 | Customer names | The same person spelled several ways (MALLAN SHEHU / MR SHEHU / MALLAM SHEHU, MODDIBO / MODIBBO). The bz3 cost sheet says Mr Umar but the log says Mrs Zubaida. Job order 8 says "BIG BRO" but the log says Muntasir Aliyu Othman. | Customer statements come out wrong | Customer records picked from a list, plus a fuzzy-duplicate check |
| 16 | P&L | A blank template, not linked to the log | The monthly P&L is assembled by hand | Generated from the ledger |

## Where each sheet goes

| Workbook sheet | Becomes |
| --- | --- |
| JOB ORDER | Job orders (car purchase or clearing only), several cars per order |
| VEHICLE COST SHEET | Each car's landed cost, built from payments and container allocations |
| TRACKER | Customer receipts matched to invoices, plus the ageing report |
| SALES&PROFIT LOG | Per-car profitability report, generated, never typed |
| P&L | Profit and loss report for any period |
| CASHBOOK | Payment vouchers, receipts, bank accounts, bank reconciliation |
| CAR PRICE LIST | Price list with valid-from and valid-to dates |

## Answers from EMM's Shop

| Question | Answer | What the system does |
| --- | --- | --- |
| What are columns N and O? | N = landing charge billed to the customer, O = actual landed cost | Clearing margin = N − O. Row 10 (O − N) has the sign reversed. Rows 25–28 (K − O) are wrong. |
| Was the ₦1m CPH fee on the Song Plus paid? | Can't be found | Left out of cost and flagged "evidence pending" until a receipt turns up |
| What does a clearing-only customer pay? | The fee varies by job | Each clearing job carries its own quoted fee on its invoice |
| Who owns the car? | Bought for the customer after they pay, except in certain (very rare) circumstances. EMM's cut varies by job. | Funding is set per job: customer-funded jobs are agent (revenue is the cut), EMM-funded jobs are principal (the car is inventory). The cut is calculated as quote minus cost, and an accepted quote is required. |
| Which rate converts an RMB selling price? | Rate on the day of the quote | The rate is locked on the job order. Any gap against the rate EMM's actually pays is FX gain or loss. |
| How to handle the 4 bad VINs? | Leave flagged for now | Imported with status "VIN needs correction". The car's file can't close until it's fixed. |
