import type { ConnectionOptions } from 'bullmq';

/** redis:// or rediss:// URL -> BullMQ connection options (BullMQ's documented option is an options object, not a URL). */
export function connectionFromUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') throw new Error('REDIS_URL must start with redis:// or rediss://');
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 6379,
    ...(u.username && { username: decodeURIComponent(u.username) }),
    ...(u.password && { password: decodeURIComponent(u.password) }),
    ...(u.protocol === 'rediss:' && { tls: {} }),
  };
}
