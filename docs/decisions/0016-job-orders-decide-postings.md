# 0016 — Job orders and the books: refuse what breaks them, flag the rest

- Status: accepted (owner, 2026-11-17)
- Date: 2026-11-17
- Implements: spec → Vehicle module (accepted quote, funding per job, EMM-funded exception path, convert to stock, exception report); CLAUDE.md → Who we are, How we book EMM's Shop. Closes the "not enforced yet" lists in ADR 0012 and ADR 0015.

## Context
We are the client's bookkeepers. The client buys, pays, sells and reviews its own deals; we record them, keep its balances, audit them and report. A first version of this slice had the database **refuse** a client's real transactions on business-policy grounds: no supplier payment before a customer receipt, none on an EMM-funded job before our reviewer approved, no conversion to stock without approval, nothing posted before the quote was accepted. That stops the books recording what really happened. The owner ruled (2026-11-17): **record, then flag.** Three ledger audits and three security reviews shaped what follows.

## Decision
**1. The database refuses only what would make a client's books wrong or untraceable.** `assert_job_entry` (migration 0014) runs inside `post_journal_entry` after the 0006–0008 checks, with the tenant's posting lock taken before any check. For every non-reversal entry naming a car:
- The car is on a job order that isn't cancelled. A draft job takes postings, which are flagged. An EMM-funded job is always a car purchase: a clearing-only job is the customer's own car, never the client's stock.
- **Funding decides the side.** An EMM-funded job's car never touches 1150, 2150, 4100 or 4200. A customer-funded job's car touches 1200, 1210, 2100, 4000 or 5000 only once converted. Funding never changes after the job is created (owner, 2026-11-17; the spec allowed a change by reversal plus approval).
- **Customer funds held (2150)** name the job's own customer.
  - They come in only through a receipt from one customer: cash in, and nothing else in the entry. A bank charge is its own entry (Dr expense / Cr cash). If a charge were allowed inside the receipt, a "charge" could conjure funds that never arrived.
  - They leave only in the car's completion, a cash refund or a conversion. A deposit is never booked as income (owner, 2026-11-15).
- **A completion** is the entry that credits a car's job costs (Cr 1150) together with applying its funds (Dr 2150), billing its customer (Dr 1100) or booking its cut (4100, 4200).
  - It happens once per car, and only after the quote is accepted.
  - It holds nothing but that car's lines: those, and FX (7000). It clears 1150 to exactly zero.
  - The cut posts nowhere else. Vehicle revenue and cost of sales (4000, 4100, 4200, 5000) always name their car.
- **Any other credit to a car's job costs** is a supplier's credit note or refund: Dr 2000 (NGN, naming the supplier) or Dr 1000 (cash back), nothing else. 0008 keeps 1150 from going below zero.
- **A supplier purchase** (a pool payment, a supplier invoice, or settling an invoice from the pool, naming the car) needs a car-purchase job, because a clearing-only job is the customer's own car.

**2. Policy questions are flags, raised as the entry commits.** The same function writes a row to `job_order_flags` (entry, car, kind) while the tenant lock is held, so flags follow the true order things happened in. A flag never changes and is never deleted: reversing the entry doesn't remove it, because the entry was recorded. Each kind:
- `emm_funded`: the first posting for an EMM-funded job's car. The treatment is principal. If that posting is reversed, the next one raises the flag again.
- `converted_to_stock`: the client converts the car to its own stock.
- `posted_before_quote`: any posting for a car whose job's quote isn't accepted yet.
- `supplier_cost_not_covered`: on a customer-funded car purchase, an entry (a reversal too) that pays the supplier or takes customer funds back, leaving the supplier **paid** more than the customer's funds held. Also any supplier payment after the car's completion, since the customer's funds were applied then. Paid means pool payments and invoice settlements; an unpaid invoice isn't cash out. The client may be financing the car itself, which would make it EMM-funded. Full cover is the owner's bar (2026-11-17).
- `cost_after_completion`: a cost posted after the car's job completed, so the cut it reported is now overstated.
- `completion_unverified`: every completion, until the completion endpoint re-performs the cut from the car's own quote. The database can't yet tell a right cut from a typed one, so a reviewer checks each one.
- `cost_credited`: a car's job costs brought down outside a completion (a supplier's credit note or refund), checked against the supplier's document.

`job_order_exceptions` (security-invoker view) is the worklist: every flag without a sign-off. `accepted_at` is stamped by the database and the app has no right to write it, so the quote time can't be backdated. Flags and sign-offs refuse UPDATE, DELETE and TRUNCATE, even by the owner.

**3. A sign-off answers one flag** (`job_order_sign_offs`: flag, reason; one per flag; insert-only, audited). It confirms our accounting treatment of what the client recorded and clears that flag; it never unlocks a posting. The app supplies only flag and reason; `signed_by` and `signed_at` come from the database. A trigger refuses:
- anyone who isn't `firm_reviewer` or `firm_admin` in this tenant's `firm_access` (owner, 2026-11-17);
- **four eyes:** anyone who touched what the flag is about. That means any `audit_log` row on the job, its cars on the job, the car record, the job's customer, its quote document or any evidence document on the car's entries, or any entry they recorded for the car.

The job is held `FOR SHARE` while it is checked. The tenant's posting lock is taken only for the entry check, so a signer can't race their own posting and a refused attempt doesn't stall the tenant's postings for long.

Only the table's owner (found from the trigger's own table, so a rename can't open it) and superusers skip the signer checks. `POST /job-orders/:id/sign-offs { flagId, reason }` is guarded by `job_orders.sign_off`. The job order response lists its flags with their sign-offs.

**4. Each car carries its own quoted price** (owner, 2026-11-17): `job_order_vehicles.car_price_minor` is required on car purchases and refused on clearing-only cars. Accepting the quote requires the cars' prices to add up to the job's quoted car price, so each car's cut can be proved from its own quote.

## Consequences
- **Next slice: allowed shapes (owner, 2026-11-17).** Four ledger audits each found a new hand-crafted line shape that slipped past these checks, because no endpoint posts yet and the database judges free-form lines. A deny list can't be complete. Every posting rule becomes a named entry type (`source_type`), each with one shape the database checks. Manual journals can't touch the job accounts (1150, 2150, 1200, 1210, 2100, 4000-4200, 5000). This is built with the posting endpoints, and the 10k fuzz test then covers job postings too; today it posts car-less lines only.
- **Open from the fourth ledger audit, closed by allowed shapes:**
  - A supplier credit note isn't tied to the car and supplier the payable was booked for. It is flagged (`cost_credited`) for now.
  - Cover counts customer funds held. A customer settling a completion receivable (1100) isn't counted as cover for a later supplier payment, so that payment is flagged conservatively.
- **Spec lines to update in the owner's Claude Doc** (`docs/spec` is exported, not hand-edited):
  - "Nothing posts to the job without an accepted quote" → nothing completes without one, and earlier postings are flagged;
  - "a firm reviewer's approval before any supplier payment posts" → flagged until a firm reviewer or admin signs off;
  - "Changing it afterwards means a reversal plus a firm reviewer's approval" → funding never changes;
  - "deposit-forfeit or refund terms" → refund only;
  - car price per car on `job_order_vehicles`;
  - the exception report reads `job_order_exceptions`.
- **Blocker for the completion endpoint:** the cut isn't re-performed yet. A completion that moves value between its own lines (say, an FX loss shown as markup) still posts. That endpoint must re-perform each car's cut from its own quote and move the job to `completed`.
- **Blocker for `POST /costs`:** a car bought for naira cash or on an NGN supplier invoice (Dr 1150 or 1200 / Cr 1000 or Cr 2000) isn't seen as a supplier payment, so it isn't flagged, and a clearing-only car could be "bought" that way. Every car cost must carry a cost type, and the car price is never one.
- **Not recordable yet, needs its own posting rule** (a gap in what can be recorded, not a judgement on the client):
  - a customer paying the China supplier directly. It needs the RMB amount, rate and evidence, like a pool payment;
  - a customer paying into, or being refunded from, the RMB account;
  - a supplier's RMB refund into the pool. Each needs a rate, its evidence, and the gap to 7000;
  - a supplier credit note after the car's completion. Its job costs are already zero, so it needs the completion reversed and redone.
- A supplier credit note on a car makes 0008 treat its job as completed (any non-conversion 1150 credit), so that car can no longer be converted to stock. Fix it in 0008's conversion check if it ever happens.
- Correcting a wrong job type or funding means reversing the car's postings and cancelling the job. A car belongs to one job for good and cancellation isn't built yet, so cancelling and re-attaching a car is needed before the first real correction.
- A clearing-only job with no costs at all can't complete, because there is no 1150 to clear. Allow it if one ever occurs.
- A signer the database refuses on role gets a 500, not a 403: SQLSTATE 42501 isn't mapped. The API guard checks the same roles first, so this is unreachable today.
- The sign-off check trusts `app.user_id`, which the API sets from the verified token. It backs up the API's guard; it is no second trust anchor. The job order shows the signer's Clerk user id to every reader, client roles included. Accepted for phase 2; revisit when firm staff get display names.
- **Bundle import:** it must restore `audit_log`, entries and flags verbatim and in order, because four eyes reads `audit_log` and flags are evidence. A future definer function owned by the table owner that inserted sign-offs would skip the signer checks; none exists.
- **Test fixture:** the phase-2 database tests run on real cars on jobs, with each job's own customer and, by default, that customer's funds held (the normal business). The four stock-car tests mark car C EMM-funded, and "Reversed mistakes" has a real clearing-only car B.
