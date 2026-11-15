# How existing platforms solve our open questions

- Date: 2026-11-15
- Looked at: Odoo, ERPNext (Frappe), Sage, Acumatica, NetSuite (community), IFRS 15 / IAS 21 guidance (Deloitte IAS Plus, Grant Thornton, BDO, CPA Ireland, IFRS Community), TigerBeetle, Formance, Blnk, and car-export tools (Export119, Carlio).
- Purpose: answer design questions with evidence. This does not replace the accountant's review.

## Findings and what we do with them

| Question | What established systems do | Our decision |
| --- | --- | --- |
| Month-end FX revaluation | Odoo posts unrealized gains/losses at the closing rate and reverses them automatically on a chosen date (usually day 1 of the next period). ERPNext has an Exchange Rate Revaluation step. | Matches spec rule 6. Build it that way (7100, auto-reverse day 1). |
| Realized FX on settlement | Difference between booking rate and settlement rate goes to P&L, posted inside the payment (ERPNext exchange gain/loss account). | Matches spec rule 5. Build it that way (7000). |
| Costing foreign cash | No system or IFRS source found uses a weighted-average pool. IAS 21: each transaction at the spot rate on its date; foreign cash is a monetary item restated at the closing rate; averages only as a shortcut when rates are stable (the naira isn't). | The pool stays as the firm's management view. **Clients see the spot basis** (ADR 0009). Needs a spot rate stored for every foreign payment. |
| Splitting container costs | ERPNext's landed cost voucher splits by quantity or amount; manual split has a reported bug; it can't charge one specific item. It saves the distribution basis with the voucher. | We already do equal, by value and single-car. Borrow the saved basis: `cost_allocations` records the split basis. |
| Agent vs principal | IFRS 15 decides on control before transfer; customer cash passing through the books does not make you a principal. | Supports ADR 0001 (customer-funded = agent, revenue = the cut). Customer funds as a liability until completion still needs the accountant's confirmation. |
| Tamper-proof ledger | TigerBeetle (open source) is immutable, append-only and hash-chained, the same idea as ADR 0006. | Keep Postgres (it also gives RLS and reporting). No new dependency. |
| Vehicle-specific competitors | Export119 and Carlio advertise landed cost per VIN, container tracking and multi-currency profit per car (vendor marketing, unverified). Nothing found for Nigerian importers on an agent model with a quote-day rate lock. | That combination is our niche. |

## Still open (research can't settle)

- Tax treatment per client (VAT, withholding tax, import VAT): chartered accountant.
- Customer funds held as a liability until completion: accountant confirmation.

## Sources

- Odoo: https://www.odoo.com/documentation/master/applications/finance/accounting/bank/foreign_currency.html , https://www.odoo.com/forum/help-1/re-why-does-odoo-reverse-the-fx-currency-gains-losses-generated-at-the-end-of-each-month-278572
- ERPNext: https://docs.frappe.io/erpnext/exchange-rate-revaluation.md , https://docs.frappe.io/erpnext/manage-foreign-exchange-difference , https://docs.frappe.io/erpnext/stock-transactions-landed-cost-voucher , https://discuss.frappe.io/t/landed-cost-voucher-distribute-charges-based-on-distribute-manually/87264 , https://discuss.frappe.io/t/recording-complex-purchases/145857
- IAS 21: https://ifrscommunity.com/knowledge-base/ias-21-effects-of-changes-in-foreign-exchange-rates/ , https://www.bdo.nz/en-nz/blogs/financial-reporting-insights/accounting-for-forex-transactions
- IFRS 15: https://www.iasplus.com/en/publications/global/a-closer-look/principal-versus-agent , https://www.grantthornton.global/en/insights/articles/ifrs-15-insights/principal-versus-agent-considerations/ , https://www.cpdbox.com/ifrs-revenue-principal-agent/
- Ledgers: https://docs.tigerbeetle.com/concepts/safety/ , https://openalternative.co/compare/blnk/vs/formance
- Car-export tools: https://export119-web.pages.dev/ , https://www.softwareadvice.com.au/software/773655/Carlio
