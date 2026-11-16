import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import type pg from 'pg';
import type { z } from 'zod';
import { withTenant, type Tx } from '@app/db';
import { IdempotencyKeyHeader } from '@app/contracts';
import type { Caller } from './auth/auth.guard.js';

export type Written<T> = { status: number; body: T };
class Replay extends Error {}

/**
 * Every write (CLAUDE.md → Ledger: idempotency keys; new-endpoint checklist): one tenant transaction that does the work
 * and stores its answer under the caller's Idempotency-Key. A retry with the same key and body gets that answer back
 * with no second effect, even when two copies race; the same key on a different request, or from another user, is a
 * 422. Audit rows come from the database's audit triggers in the same transaction.
 * ponytail: keys and their stored answers are kept; a worker job deletes rows older than 7 days (gate item, ADR 0014).
 */
export async function idempotentWrite<T>(
  pool: pg.Pool, caller: Caller, rawKey: string | undefined, request: { route: string; body: unknown },
  fn: (tx: Tx) => Promise<Written<T>>,
): Promise<Written<T>> {
  const key = IdempotencyKeyHeader.safeParse(rawKey);
  if (!key.success) throw new BadRequestException('Idempotency-Key header is required on writes');
  const hash = createHash('sha256').update(JSON.stringify([caller.userId, request.route, request.body])).digest('hex');
  const stored = (t: Tx) => t.client.query<{ request_hash: string; status_code: number; response: T }>(
    'SELECT request_hash, status_code, response FROM idempotency_keys WHERE tenant_id = $1 AND key = $2', [caller.tenantId, key.data]);
  const answer = (row: { request_hash: string; status_code: number; response: T }): Written<T> => {
    if (row.request_hash !== hash) throw new UnprocessableEntityException('this Idempotency-Key was already used for a different request');
    return { status: row.status_code, body: row.response };
  };
  const actor = { tenantId: caller.tenantId, userId: caller.userId };
  try {
    return await withTenant(pool, actor, async (t) => {
      const earlier = (await stored(t)).rows[0];
      if (earlier) return answer(earlier);
      const result = await fn(t);
      const saved = await t.client.query(
        `INSERT INTO idempotency_keys (tenant_id, key, request_hash, status_code, response) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`, [caller.tenantId, key.data, hash, result.status, JSON.stringify(result.body)]);
      if (saved.rowCount !== 1) throw new Replay(); // a concurrent copy committed first: undo ours, return theirs
      return result;
    });
  } catch (err) {
    // A copy of this request that committed first can also make ours fail on a business key (a VIN, say) before we
    // reach the key insert: whenever ours fails, a stored answer for this key wins.
    const row = await withTenant(pool, actor, async (t) => (await stored(t)).rows[0]);
    if (row) return answer(row);
    if (err instanceof Replay) throw new ConflictException();
    throw err;
  }
}

/** A unique violation on the named constraint becomes a 409 with our own words; anything else stays an error. */
export function conflictOn(constraint: string, message: string) {
  return (err: unknown): never => {
    if (err instanceof Error && 'code' in err && err.code === '23505' && 'constraint' in err && err.constraint === constraint) throw new ConflictException(message);
    throw err;
  };
}

/** Every API input goes through Zod (CLAUDE.md): a failure is a 400 listing the fields, never a 500. */
export function input<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ message: 'invalid input', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return parsed.data;
}
