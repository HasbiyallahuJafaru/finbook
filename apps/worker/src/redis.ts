import { Redis, type RedisOptions } from 'ioredis';

/**
 * BullMQ 6 does not bundle ioredis, and in native ESM it needs a ready-made client.
 * maxRetriesPerRequest: null is required for BullMQ workers; family: 0 lets Railway's private network resolve (IPv4 + IPv6).
 */
export function redisClient(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, family: 0, ...options });
}
