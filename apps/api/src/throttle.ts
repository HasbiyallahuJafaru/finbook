import { Logger } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';
import * as Sentry from '@sentry/nestjs';
import { Redis } from 'ioredis';

// One atomic step per request: count the hit, start the window on the first, block for blockDuration once over the
// limit. Times come back in whole seconds, as ThrottlerGuard expects.
const SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local blocked = redis.call('PTTL', KEYS[2])
if blocked <= 0 and hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], 1, 'PX', ARGV[3])
  blocked = tonumber(ARGV[3])
end
return { hits, math.ceil(redis.call('PTTL', KEYS[1]) / 1000), math.ceil(math.max(blocked, 0) / 1000) }`;

/**
 * Rate-limit counters in Redis, shared by every api instance (spec: login and write endpoints are rate limited in Redis).
 * Written here because the community Redis storage doesn't support NestJS 12 yet (ADR 0014). If Redis is unreachable,
 * the counters fall back to this process's memory: still limited, never an outage.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly fallback = new ThrottlerStorageService();

  constructor(private readonly redis: Redis) {
    redis.on('error', (err: Error) => { Logger.error(`Redis: ${err.message}`, 'Throttle'); });
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    const k = `throttle:${throttlerName}:${key}`;
    try {
      const [totalHits = 0, timeToExpire = 0, timeToBlockExpire = 0] = (await this.redis.eval(SCRIPT, 2, k, `${k}:blocked`, ttl, limit, blockDuration)) as number[];
      return { totalHits, timeToExpire, isBlocked: timeToBlockExpire > 0, timeToBlockExpire };
    } catch (err) {
      Sentry.captureException(err);
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }
}

/** Redis when REDIS_URL is set (every deployed environment), else the built-in in-memory counter. */
export function throttlerStorage(): ThrottlerStorage | undefined {
  if (!process.env.REDIS_URL) {
    // ponytail: in-memory counters per process; fine for one local instance, every deployed one sets REDIS_URL
    Logger.warn('REDIS_URL is not set: rate limits are per process', 'Throttle');
    return undefined;
  }
  return new RedisThrottlerStorage(new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 }));
}

/** The user id the token claims, unverified: used only to pick a counter, never to grant anything. */
function claimedUser(authorization: unknown): string {
  try {
    const payload = /^Bearer [^.\s]+\.([^.\s]+)\.[^.\s]+$/.exec(typeof authorization === 'string' ? authorization : '')?.[1] ?? '';
    const sub: unknown = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub.slice(0, 64) : '';
  } catch {
    return '';
  }
}

/**
 * Runs BEFORE the auth guard, so failed sign-ins and callers without access are counted too (each one would otherwise
 * cost a database round trip for free). The counter is the client IP plus the user the token claims: users behind one
 * mobile-carrier IP get their own counters, and a forged token naming someone else can't use up their counter
 * unless it comes from their IP.
 */
export class CallerThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = req.headers as Record<string, unknown> | undefined;
    return `${await super.getTracker(req)}|${claimedUser(headers?.authorization)}`;
  }
}

/** Limits: every route per caller per minute, and a tighter one per write route (@Throttle(WRITE_LIMIT)). */
export const DEFAULT_LIMIT = { ttl: 60_000, limit: 300 };
export const WRITE_LIMIT = { default: { ttl: 60_000, limit: 60 } };
