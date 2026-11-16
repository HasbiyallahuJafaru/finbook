import { createHash } from 'node:crypto';
import { Body, Controller, Get, Headers, Inject, NotFoundException, Param, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type pg from 'pg';
import { withTenant } from '@app/db';
import { CreateUpload, IdempotencyKeyHeader, MAX_DOCUMENT_BYTES, type Document, type DownloadTicket, type UploadTicket } from '@app/contracts';
import { Can } from './auth/permissions.js';
import type { Caller } from './auth/auth.guard.js';
import { POOL, STORAGE } from './db.js';
import { sniffMime, type Storage } from './storage.js';
import { WRITE_LIMIT } from './throttle.js';
import { idempotentWrite, input } from './write.js';

const COLUMNS = `id, doc_type AS "docType", status, mime, size_bytes AS "sizeBytes", sha256, original_filename AS "filename",
  rejected_reason AS "rejectedReason", uploaded_by AS "uploadedBy"`;
type Status = { status(code: number): void };

// ponytail: a per-process cap on concurrent confirms (each holds up to 20 MB); a worker queue replaces it (ADR 0015).
const CONFIRM_SLOTS = 3;
let busy = 0;

/** Evidence (spec → Document storage): the API never handles the upload itself, only the ticket and the check. */
@Controller('documents')
export class DocumentsController {
  constructor(@Inject(POOL) private readonly pool: pg.Pool, @Inject(STORAGE) private readonly storage: Storage | null) {}

  private get r2(): Storage {
    if (!this.storage) throw new ServiceUnavailableException();
    return this.storage;
  }

  /** Step 1: record what is coming and hand back a 10-minute presigned PUT for exactly that type and size. */
  @Post('uploads')
  @Can('documents.upload')
  @Throttle(WRITE_LIMIT)
  async upload(@Req() req: { caller: Caller }, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Status): Promise<UploadTicket> {
    const r2 = this.r2;
    const u = input(CreateUpload, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /documents/uploads', body: u }, async ({ client }) => {
      const document = (await client.query<Document>(
        `INSERT INTO documents (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
        [req.caller.tenantId, u.docType, u.mime, u.sizeBytes, u.sha256, u.filename])).rows[0] as Document;
      return { status: 201, body: { document, upload: { method: 'PUT' as const, ...(await r2.presignUpload(r2.stagingKey(req.caller.tenantId, document.id), u.mime, u.sizeBytes)) } } };
    });
    res.status(out.status);
    return out.body;
  }

  /**
   * Step 2, after the PUT: check the bytes against what was declared (size, SHA-256, real type from the first bytes),
   * then write exactly those bytes into evidence. A mismatch marks the document rejected for good (422 with the
   * reason); re-upload as a new document. The R2 work runs outside any database transaction (no pooled connection or
   * row lock is held while 20 MB moves), and at most CONFIRM_SLOTS confirms run at once in this process.
   * ponytail: checked here, synchronously; moves to a worker job when HEIC conversion and thumbnails come (ADR 0015).
   */
  @Post(':id/confirm')
  @Can('documents.upload')
  @Throttle(WRITE_LIMIT)
  async confirm(@Req() req: { caller: Caller }, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Status): Promise<Document> {
    const r2 = this.r2;
    const documentId = input(z.uuid(), id);
    input(IdempotencyKeyHeader, key); // a write: the key is required even on the paths that return early
    const current = () => withTenant(this.pool, req.caller, async ({ client }) => (await client.query<Document & { createdMonth: string }>(
      `SELECT ${COLUMNS}, to_char(created_at AT TIME ZONE 'UTC', 'YYYY/MM') AS "createdMonth" FROM documents WHERE id = $1`, [documentId])).rows[0]);
    const final = (doc: Document) => { res.status(doc.status === 'rejected' ? 422 : 200); return doc; };

    const found = await current();
    if (!found) throw new NotFoundException();
    const { createdMonth, ...doc } = found;
    if (doc.status !== 'pending') return final(doc); // already checked: the same answer every time
    if (busy >= CONFIRM_SLOTS) throw new ServiceUnavailableException('busy checking other files, try again in a moment');
    busy++;
    let outcome: { evidenceKey: string } | { problem: string };
    try {
      const bytes = await r2.readStaged(r2.stagingKey(req.caller.tenantId, doc.id), MAX_DOCUMENT_BYTES);
      if (!bytes) throw new NotFoundException('nothing has been uploaded for this document yet');
      const problem = bytes.length !== doc.sizeBytes ? `the file is ${String(bytes.length)} bytes, ${String(doc.sizeBytes)} were declared`
        : createHash('sha256').update(bytes).digest('hex') !== doc.sha256 ? 'the file does not match the declared SHA-256'
          : sniffMime(bytes) !== doc.mime ? `the file is not a ${doc.mime}` : null;
      if (problem) outcome = { problem };
      else {
        const evidenceKey = r2.evidenceKey(req.caller.tenantId, doc.id, doc.mime, createdMonth);
        // The verified bytes themselves. If the commit below fails, a retry finds the same file under the same key and
        // finishes; bytes stored by a confirm that then loses a race are the same file, kept for the retention period.
        await r2.putEvidence(evidenceKey, bytes, doc.mime, doc.sha256);
        outcome = { evidenceKey };
      }
    } finally {
      busy--;
    }
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /documents/:id/confirm', body: documentId }, async ({ client }) => {
      const updated = 'problem' in outcome
        ? await client.query<Document>(`UPDATE documents SET status = 'rejected', rejected_reason = $2 WHERE id = $1 AND status = 'pending' RETURNING ${COLUMNS}`, [doc.id, outcome.problem])
        : await client.query<Document>(`UPDATE documents SET status = 'stored', evidence_key = $2, stored_at = now() WHERE id = $1 AND status = 'pending' RETURNING ${COLUMNS}`, [doc.id, outcome.evidenceKey]);
      // A concurrent confirm finished first: its result stands.
      const row = updated.rows[0] ?? (await client.query<Document>(`SELECT ${COLUMNS} FROM documents WHERE id = $1`, [doc.id])).rows[0] ?? doc;
      return { status: row.status === 'rejected' ? 422 : 200, body: row };
    });
    res.status(out.status);
    return out.body;
  }

  /** A 5-minute presigned GET for a stored document; every view is written to audit_log (spec: auditors' views too). */
  @Get(':id/download')
  @Can('documents.read')
  async download(@Req() req: { caller: Caller }, @Param('id') id: string): Promise<DownloadTicket> {
    const r2 = this.r2;
    const documentId = input(z.uuid(), id);
    const found = await withTenant(this.pool, req.caller, async ({ client }) => {
      const row = (await client.query<{ evidence_key: string; mime: string }>("SELECT evidence_key, mime FROM documents WHERE id = $1 AND status = 'stored'", [documentId])).rows[0];
      if (row) await client.query("INSERT INTO audit_log (tenant_id, action, entity, entity_id) VALUES ($1, 'view', 'documents', $2)", [req.caller.tenantId, documentId]);
      return row;
    });
    if (!found) throw new NotFoundException(); // another tenant's, unknown or not yet stored: the same answer
    return r2.presignDownload(found.evidence_key, documentId, found.mime);
  }
}
