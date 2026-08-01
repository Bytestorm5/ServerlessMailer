/**
 * Mongo-backed fixed-window rate limiting (§12).
 *
 * Used to blunt signup abuse — per IP and per address — and to enforce the
 * once-per-hour confirmation resend (§5.1). It is deliberately boring: one
 * document per `(key, window)`, one atomic `findOneAndUpdate` upsert per
 * consume, and a TTL field so expired windows are reaped by Mongo rather than
 * by a cleanup job.
 *
 * The atomicity matters. A read-then-write limiter lets N concurrent requests
 * all observe the same pre-increment count and all pass, which is precisely
 * the shape of the traffic a limiter exists to stop. `$inc` inside a single
 * document update is the guarantee: every caller gets a distinct count back,
 * so at most `limit` of them can ever see an allowed result.
 */

import type { Filter } from 'mongodb';
import { rateLimitsCollection } from '@/lib/db/collections';
import { logger } from '@/lib/logging';
import type { RateLimitDoc } from '@/lib/types';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Concurrent upserts of the same not-yet-existing `_id` can collide on the
 * unique index; the loser retries once the winner's document exists.
 */
const MAX_UPSERT_ATTEMPTS = 3;

function assertKey(key: string, fn: string): void {
  if (typeof key !== 'string' || key.trim().length === 0) {
    // An empty key would bucket every caller together, which is worse than no
    // limiter at all: one abuser would lock out every legitimate signup.
    throw new RangeError(`${fn}: key must be a non-empty string`);
  }
}

function assertNow(now: Date, fn: string): void {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError(`${fn}: now must be a valid Date`);
  }
}

/** A non-numeric or negative limit denies rather than throwing — fail closed. */
function effectiveLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.floor(limit) : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * Records one use of `key` in the current window.
 *
 * Callers must use a distinct key per limit (`signup:ip:…` vs
 * `confirm-resend:…`): the document id is `key:windowIndex`, and two different
 * window lengths on the same key can, at different times, land on the same
 * index and therefore the same document.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  assertKey(key, 'consumeRateLimit');
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(
      'consumeRateLimit: windowMs must be a positive, finite number of milliseconds',
    );
  }
  assertNow(now, 'consumeRateLimit');

  // Windows are aligned to the epoch, not to the first request, so every
  // process agrees on the boundary without coordinating.
  const windowIndex = Math.floor(now.getTime() / windowMs);
  const windowStart = new Date(windowIndex * windowMs);
  const resetAt = new Date((windowIndex + 1) * windowMs);
  const id = `${key}:${windowIndex}`;

  const collection = await rateLimitsCollection();

  let count = 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const doc = await collection.findOneAndUpdate(
        { _id: id },
        {
          $inc: { count: 1 },
          // `expiresAt` is both the reset instant and the TTL field the index
          // in db/indexes.ts expires on, so windows self-reap.
          $setOnInsert: { windowStart, expiresAt: resetAt },
        },
        { upsert: true, returnDocument: 'after' },
      );
      count = doc?.count ?? 1;
      break;
    } catch (error) {
      if (isDuplicateKeyError(error) && attempt < MAX_UPSERT_ATTEMPTS) continue;
      // Anything else is a real failure. It must surface rather than be
      // swallowed into an "allowed" answer that hands an attacker the door.
      throw error;
    }
  }

  const max = effectiveLimit(limit);
  const allowed = count <= max;
  if (!allowed) {
    // `logger` scrubs anything address-shaped: keys often embed an address.
    logger.warn('rate limit exceeded', { key, count, limit: max });
  }

  return {
    allowed,
    remaining: Math.max(0, max - count),
    resetAt: new Date(resetAt.getTime()),
  };
}

/**
 * Reports the current window without consuming from it — for surfacing "you
 * can try again at HH:MM" without spending the caller's allowance.
 *
 * The window length is not a parameter here, so the active window is found by
 * key instead of computed: the most recently started window that has not yet
 * expired, breaking ties towards the shortest one.
 */
export async function peekRateLimit(
  key: string,
  limit: number,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  assertKey(key, 'peekRateLimit');
  assertNow(now, 'peekRateLimit');

  const collection = await rateLimitsCollection();
  const filter: Filter<RateLimitDoc> = {
    // Anchored and escaped: a key is attacker-influenced (it embeds an IP or
    // an address), so it is matched literally and can never be a pattern.
    // Requiring digits after the colon stops key `a` from reading key `a:b`.
    _id: { $regex: new RegExp(`^${escapeRegExp(key)}:-?\\d+$`) },
    expiresAt: { $gt: now },
  };

  const [doc] = await collection
    .find(filter)
    .sort({ windowStart: -1, expiresAt: 1 })
    .limit(1)
    .toArray();

  const max = effectiveLimit(limit);
  const count = doc?.count ?? 0;

  return {
    allowed: count < max,
    remaining: Math.max(0, max - count),
    resetAt: doc ? new Date(doc.expiresAt.getTime()) : new Date(now.getTime()),
  };
}
