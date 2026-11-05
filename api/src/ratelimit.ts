import crypto from 'crypto';
import { HttpRequest } from '@azure/functions';
import { RateLimitError } from './auth/otp';
import { getStore } from './store';

/**
 * Sliding-window limiter: each hit is its own short-lived doc (Cosmos TTL cleans up). Insert first, then count,
 * so parallel requests can't all slip past a read-then-write counter: at most `max` hits per window succeed.
 * Rejected hits are removed again so they don't extend the block. Throws RateLimitError when over the limit.
 */
export async function hitRateLimit(key: string, max: number, windowMs: number, message = 'Too many requests. Please try again later.') {
  const store = getStore();
  const k = crypto.createHash('sha256').update(`rl:${key}`).digest('hex');
  const now = Date.now();
  const id = crypto.randomUUID();
  await store.put({ id, type: 'ratelimit', key: k, at: now }, Math.ceil(windowMs / 1000));
  const hits = (await store.list('ratelimit'))
    .filter((d) => d.key === k && now - Number(d.at) < windowMs)
    .sort((a, b) => Number(a.at) - Number(b.at) || String(a.id).localeCompare(String(b.id)));
  if (hits.findIndex((d) => d.id === id) >= max) {
    await store.delete('ratelimit', id).catch(() => undefined);
    throw new RateLimitError(message);
  }
}

/** Client IP: Azure-set headers first, then the first X-Forwarded-For hop; ports stripped. */
export function clientIp(req: HttpRequest): string {
  const raw = req.headers.get('x-azure-clientip') ?? req.headers.get('x-client-ip')
    ?? (req.headers.get('x-forwarded-for') ?? '').split(',')[0];
  const ip = raw.trim();
  // "1.2.3.4:5678" → "1.2.3.4"; leave IPv6 (multiple colons) alone apart from [brackets]:port.
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(ip);
  if (v4) return v4[1];
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  return (v6?.[1] ?? ip) || 'unknown';
}
