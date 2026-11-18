# 0019: Car costs, cost types and containers

- Status: accepted (owner defaults 2026-11-17; built 2026-11-18)
- Date: 2026-11-18
- Implements: spec → landed cost components and shared-cost allocation; ADR 0016 → the `POST /costs` blocker. Migration 0019.

## Context
The spec splits a client's naira car costs in one of two ways. Some belong to one car (IDEC bill, NCS FOB levy, CPH fee). Others are paid once for a container and shared across its cars (Form M, PAAR, shipping, transport). The workbook typed a "C4-" prefix into item names and split costs in thirds that didn't add back to what was paid. The owner set the defaults (2026-11-17):
- split by value means each car's supplier cost in NGN at pool cost;
- evidence may be pending unless the cost type requires a receipt;
- any recorder closes a container, and it never reopens;
- every cash-paid car cost carries a cost type, and the car price is never one.

## Decision
1. **A car cost is a posting type, not a route.** `POST /postings` with `type: 'car_cost'`, following the owner's ruling of one posting route (ADR 0018). PROGRESS called it `POST /costs`. The request carries the cost type, the amount, the date, evidence and the split. The split is one of:
   - `per_car` (one car);
   - `equal` or `by_value` over a container;
   - `manual` shares, inside a container or not.

   Each car's funding comes from its job, and its weight comes from its ledger.
2. **Cost types are per client** (`cost_types`), seeded at onboarding by `seed_default_cost_types` from the spec's table: 12 capitalized naira types, each with a default split. CPH extra fee requires its receipt. The car price is never a cost type: it is the supplier payment. The RMB China-side extra isn't one either, because it is paid from the pool. Clients add their own types. Renaming waits until it's needed, since a renamed type would change what past entries say.
3. **The split is kept and re-performed** (`cost_allocations`, one row per car in order, with the remainder on position 1). `allocateCarCost` in `packages/ledger` builds the lines and the split. `assert_car_cost`, called from `post_journal_entry`, checks it again:
   - the rows are the entry's own cost lines, car by car, to the kobo;
   - the entry has one cost type, one basis, and one container or none;
   - equal and by-value shares are re-worked in SQL: total × weight ÷ total weight, rounded down, with the remainder on the first car;
   - a by-value weight must equal the car's supplier cost in NGN at pool cost, read from its ledger. This matches `carCost` in `packages/ledger`: pool payments, plus supplier invoices at their booked rate;
   - a container's equal or by-value cost covers exactly its current cars, while a manual split may leave one out;
   - a cost type that requires a receipt doesn't post without one (the owner's default, the one exception to "evidence pending").
   - a cost for a closed container **posts and is flagged** `cost_after_container_closed` on each car (ledger audit: a late demurrage bill is real; record, then flag);
   - a share that would round to nothing is a rule refusal ("split it by hand"), never a nil row.

   A split can only be written with its own car cost, before that entry is sealed. It is never changed or deleted.
4. **Containers** (`shipments`, `shipment_vehicles`). A car travels in one container at a time.
   - **Taking a car out.** A car put in the wrong container is taken out with a reason (`POST /shipments/:id/vehicles/:vehicleId/remove`). The database stamps who and when, and the row stays, so the membership history is kept. This is allowed only while the container is open and no standing cost of that container is split onto the car; reverse that cost first. (Ledger audit: a wrong classification is corrected, never left standing.)
   - **Closing.** Closing stamps who and when from the database. After that no car joins or leaves, and the container never reopens. Late costs still post, flagged (above).
   - **Locks.** Closing, adding a car and taking one out all take the tenant's posting lock in the database, so none of them interleaves with a container cost being split (security review).
5. **Funding of a converted car.** A car with a standing conversion to stock is EMM stock, whatever its job's funding. Its costs, and any pool payment or invoice, go to inventory (1200), as 0008 requires (ledger audit). Before this, a cost on a converted car was refused.
6. **Who keeps cost types.** Firm admins and accountants and the client owner add cost types; client staff don't. A look-alike type without the receipt rule would otherwise let a staff member skip it (security review). Any recorder handles containers (owner default).

## Consequences
- The ADR 0016 blocker is closed. A naira cash cost on a car now always names its cost type, so a car can't be "bought" through an unlabelled cash cost.
- The spec rule "a container can't close until its allocated costs equal its paid costs" always holds: every cost's split equals its own lines, checked as it posts.
- **Not built:**
  - costs that aren't capitalized (travel, salaries; spec: operating expenses, never capitalized) need their own entry type;
  - an RMB cost on a car that isn't the car price;
  - costs paid on a supplier's naira invoice rather than in cash;
  - renaming a cost type;
  - flags for duplicate cost entries (same car and cost type), a spec exception report that comes with the exception-report endpoints.
- Reversing a car cost mirrors its lines and needs no split of its own. Reports read a car's costs from its lines, and its splits from the original entry, filtered to standing entries.
- **Ceiling: the split is outside the hash chain.** App roles can't change or delete a split (`forbid_change`), and its shares must equal the hashed lines. But a database superuser could relabel a split's cost type, basis or container without breaking the chain. Add the split to the hash payload (v4) with the off-site anchor work in phase 5.
- **Still open:**
  - **A cost after arrival in the yard.** An EMM-funded car's naira cost after it reaches the yard lands in 1200 (in transit). The sale is then refused ("still in transit") until a second arrival moves it to 1210. The books stay right, but the sale waits. Either let `car_cost` post to 1210 for a car in the yard (an entry-shape change), or flag it.
  - **Earlier gap now fixed:** pool payments and supplier invoices on a converted car share the funding fix in 5.
