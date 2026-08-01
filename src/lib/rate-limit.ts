import { collections } from './db';

/**
 * Fixed-window rate limiting backed by MongoDB.
 *
 * No Redis, deliberately: this system already depends on Mongo being up, and
 * adding a second datastore to protect a signup form is not a trade worth
 * making. Counters expire through a TTL index.
 */

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  resetAt: Date;
}

export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const c = await collections();
  const now = new Date();
  const windowMs = windowSeconds * 1000;
  // Bucket boundary derived from the clock so concurrent invocations agree.
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const expiresAt = new Date(windowStart.getTime() + windowMs);
  const id = `${key}:${windowStart.getTime()}`;

  const doc = await c.rateLimits.findOneAndUpdate(
    { _id: id },
    {
      $inc: { count: 1 },
      $setOnInsert: { windowStart, expiresAt },
    },
    { upsert: true, returnDocument: 'after' },
  );

  const count = doc?.count ?? 1;
  return { allowed: count <= limit, count, limit, resetAt: expiresAt };
}

/** Reads a counter without consuming it. */
export async function peekRateLimit(key: string, windowSeconds: number): Promise<number> {
  const c = await collections();
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const doc = await c.rateLimits.findOne({ _id: `${key}:${windowStart.getTime()}` });
  return doc?.count ?? 0;
}

/**
 * Best-effort client IP. Vercel sets `x-forwarded-for`; the left-most entry is
 * the client. Used only for rate limiting and consent evidence, never for
 * authorization.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip') ?? headers.get('cf-connecting-ip') ?? '0.0.0.0';
}
