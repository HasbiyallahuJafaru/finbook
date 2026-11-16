# 0015 — Evidence documents and job orders

- Status: proposed (built 2026-11-16; owner to confirm the deviation below)
- Date: 2026-11-16
- Implements: spec → Document storage (upload flow, rules), Vehicle module (job orders, accepted quote), Data model (`job_orders`, `job_order_vehicles`, `documents`); CLAUDE.md → gapless numbers, evidence never replaced

## Decision
- **Uploads never pass through the API.** `POST /documents/uploads` records the declared type, size, SHA-256 and filename (`documents`, status `pending`) and returns a 10-minute presigned PUT to the `staging` bucket at `staging/{tenant}/{document}`, with Content-Type and Content-Length signed.
- **The check runs in the API, not the worker (deviation from the spec's step 4).** `POST /documents/:id/confirm` reads the staged bytes (at most 20 MB), checks size, SHA-256 and the real type from the first bytes, then writes **those verified bytes** (never a copy of the staged object, which the uploader could still replace while the PUT link lives) to `evidence/{tenant}/{yyyy}/{mm}/{document}.{ext}` and marks the document `stored`. The R2 work runs outside any database transaction, and at most 3 confirms run at once per api process. A mismatch marks it `rejected` with the reason, for good. Why: the worker has no tenant database access yet (only the rates login), and the check is fast. It moves to a worker job when HEIC conversion and thumbnails arrive. The API's R2 token therefore needs read on `staging` and write on `evidence` (the spec gives that to the worker). R2 tokens can't grant write without delete, so the `evidence` bucket lock is what stops a leaked key from deleting or overwriting evidence; it must be in place, and tested, before any `R2_*` variable is set.
- **A document is checked once:** `pending` → `stored` or `rejected`, then never changes; nobody deletes one, not even the database owner. A wrong file is superseded by uploading a new one.
- **Downloads:** a 5-minute presigned GET from `evidence`, only for stored documents, always as an attachment named by id; each view writes an `audit_log` row (`action = 'view'`). A stored key must sit under the tenant's own `evidence/{tenant}/` prefix (database check).
- **Job orders** (`POST /job-orders`, cars via `POST /job-orders/:id/vehicles`, `POST /job-orders/:id/accept-quote`):
  - the number comes from a per-tenant counter row (`tenant_counters`), moved only by a trigger running as the owner: gapless (a rolled-back order gives its number back), never chosen or moved by the app;
  - the customer must be one of the tenant's counterparties of kind `customer` (composite foreign key);
  - a car purchase quotes the car's price in its foreign currency at a quote-day rate marked `cbn`, `market` (checked against `fx_reference_rates`, as spot rates are in 0005) or `manual` (with a note); clearing-only has neither;
  - the quote is accepted once, with a stored `accepted_quote` document and at least one car; after that the quote columns can't be updated at all and no car can be added;
  - one car is on at most one job order, and one accepted-quote document backs at most one job order.

## Consequences
- **Not yet enforced (next slice, ledger side, `ledger-change` skill):** no posting to a job without an accepted quote; funding per job deciding 1150 vs 1200; a firm reviewer's approval before an EMM-funded supplier payment and before convert-to-stock; funding locked at the first payment; the job type as proof of a supplier purchase.
- An EMM-funded job can be created by any recorder with a reason; **no supplier payment may treat `funding = 'emm_funded'` as approved** until the reviewer-approval step exists (next slice).
- Not built: superseding notes, the "same SHA-256 on two payments" flag, the monthly re-hash sample, HEIC→JPEG and thumbnails, the staging lifecycle rule (a bucket setting).
- Tests run against S3Mock (MinIO no longer publishes images). S3Mock doesn't check signatures, so the signed Content-Type/Length is only enforced by R2 itself.
- R2 buckets and least-privilege tokens per environment are owner setup (Cloudflare login); until the `R2_*` variables are set, document routes answer 503.
