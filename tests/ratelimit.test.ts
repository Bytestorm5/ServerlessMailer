import { Collection } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rateLimitsCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { consumeRateLimit, peekRateLimit } from '@/lib/ratelimit';
import type { RateLimitDoc } from '@/lib/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A fresh key per test, so cases inside this file never share a window. */
let counter = 0;
function uniqueKey(prefix = 'k'): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

const T = new Date('2026-08-01T12:00:30.000Z');

function windowIndexOf(now: Date, windowMs: number): number {
  return Math.floor(now.getTime() / windowMs);
}

async function docFor(key: string, now: Date, windowMs: number) {
  const col = await rateLimitsCollection();
  return col.findOne({ _id: `${key}:${windowIndexOf(now, windowMs)}` });
}

beforeEach(async () => {
  await ensureIndexes();
});

describe('consumeRateLimit', () => {
  it('allows the first call and reports the remaining allowance', async () => {
    const key = uniqueKey();
    const result = await consumeRateLimit(key, 3, MINUTE, T);
    expect(result).toEqual({
      allowed: true,
      remaining: 2,
      resetAt: new Date('2026-08-01T12:01:00.000Z'),
    });
  });

  it('counts down and then denies, never going negative', async () => {
    const key = uniqueKey();
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await consumeRateLimit(key, 3, MINUTE, T));
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0, 0]);
  });

  it('stores exactly one document, keyed by `key:windowIndex`', async () => {
    const key = uniqueKey();
    await consumeRateLimit(key, 5, MINUTE, T);
    await consumeRateLimit(key, 5, MINUTE, new Date(T.getTime() + 25_000));

    const col = await rateLimitsCollection();
    const docs = await col.find({}).toArray();
    const mine = docs.filter((d) => d._id.startsWith(`${key}:`));
    expect(mine).toHaveLength(1);
    expect(mine[0]._id).toBe(`${key}:${windowIndexOf(T, MINUTE)}`);
    expect(mine[0].count).toBe(2);
  });

  it('records windowStart and a TTL field so old windows self-reap', async () => {
    const key = uniqueKey();
    await consumeRateLimit(key, 5, MINUTE, T);
    const doc = await docFor(key, T, MINUTE);
    expect(doc?.windowStart).toEqual(new Date('2026-08-01T12:00:00.000Z'));
    expect(doc?.expiresAt).toEqual(new Date('2026-08-01T12:01:00.000Z'));
  });

  it('relies on a TTL index over expiresAt', async () => {
    const col = await rateLimitsCollection();
    const indexes = await col.indexes();
    const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl?.key).toEqual({ expiresAt: 1 });
    expect(ttl?.expireAfterSeconds).toBe(0);
  });

  it('does not reset the window start when the window is re-entered', async () => {
    const key = uniqueKey();
    await consumeRateLimit(key, 5, MINUTE, T);
    const later = new Date(T.getTime() + 20_000);
    const second = await consumeRateLimit(key, 5, MINUTE, later);
    expect(second.resetAt).toEqual(new Date('2026-08-01T12:01:00.000Z'));
    const doc = await docFor(key, T, MINUTE);
    expect(doc?.windowStart).toEqual(new Date('2026-08-01T12:00:00.000Z'));
  });

  it('keeps separate keys independent', async () => {
    const a = uniqueKey('a');
    const b = uniqueKey('b');
    await consumeRateLimit(a, 1, MINUTE, T);
    const exhausted = await consumeRateLimit(a, 1, MINUTE, T);
    const other = await consumeRateLimit(b, 1, MINUTE, T);
    expect(exhausted.allowed).toBe(false);
    expect(other.allowed).toBe(true);
  });

  it('starts a fresh allowance in the next window', async () => {
    const key = uniqueKey();
    await consumeRateLimit(key, 1, MINUTE, T);
    expect((await consumeRateLimit(key, 1, MINUTE, T)).allowed).toBe(false);

    const next = new Date(T.getTime() + MINUTE);
    const after = await consumeRateLimit(key, 1, MINUTE, next);
    expect(after.allowed).toBe(true);
    expect(after.resetAt).toEqual(new Date('2026-08-01T12:02:00.000Z'));

    const col = await rateLimitsCollection();
    const mine = await col.find({}).toArray();
    expect(mine.filter((d) => d._id.startsWith(`${key}:`))).toHaveLength(2);
  });

  it('aligns windows to the epoch, not to the first call', async () => {
    const key = uniqueKey();
    // 12:00:59 and 12:01:00 are one second apart but in different windows.
    const late = new Date('2026-08-01T12:00:59.999Z');
    const rollover = new Date('2026-08-01T12:01:00.000Z');
    await consumeRateLimit(key, 1, MINUTE, late);
    expect((await consumeRateLimit(key, 1, MINUTE, late)).allowed).toBe(false);
    expect((await consumeRateLimit(key, 1, MINUTE, rollover)).allowed).toBe(true);
  });

  it('treats every instant inside a window as the same bucket', async () => {
    const key = uniqueKey();
    const start = new Date('2026-08-01T12:00:00.000Z');
    const end = new Date('2026-08-01T12:00:59.999Z');
    expect((await consumeRateLimit(key, 2, MINUTE, start)).remaining).toBe(1);
    expect((await consumeRateLimit(key, 2, MINUTE, end)).remaining).toBe(0);
    expect((await consumeRateLimit(key, 2, MINUTE, end)).allowed).toBe(false);
  });

  it('supports hour-long windows, as the signup limits use', async () => {
    const key = uniqueKey();
    const first = await consumeRateLimit(key, 3, HOUR, T);
    expect(first.resetAt).toEqual(new Date('2026-08-01T13:00:00.000Z'));
    const nextHour = new Date('2026-08-01T13:00:00.000Z');
    expect((await consumeRateLimit(key, 1, HOUR, nextHour)).allowed).toBe(true);
  });

  it('defaults now to the current time', async () => {
    const key = uniqueKey();
    const before = Date.now();
    const result = await consumeRateLimit(key, 2, HOUR);
    expect(result.allowed).toBe(true);
    expect(result.resetAt.getTime()).toBeGreaterThan(before);
    const col = await rateLimitsCollection();
    const docs = await col.find({}).toArray();
    expect(docs.some((d) => d._id.startsWith(`${key}:`))).toBe(true);
  });

  it('returns a resetAt that callers cannot mutate into shared state', async () => {
    const key = uniqueKey();
    const a = await consumeRateLimit(key, 5, MINUTE, T);
    a.resetAt.setFullYear(1999);
    const b = await consumeRateLimit(key, 5, MINUTE, T);
    expect(b.resetAt).toEqual(new Date('2026-08-01T12:01:00.000Z'));
  });

  it('denies everything when the limit is zero', async () => {
    const key = uniqueKey();
    const result = await consumeRateLimit(key, 0, MINUTE, T);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('denies everything when the limit is negative', async () => {
    const key = uniqueKey();
    const result = await consumeRateLimit(key, -5, MINUTE, T);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('fails closed when the limit is not a number', async () => {
    const key = uniqueKey();
    const result = await consumeRateLimit(key, Number.NaN, MINUTE, T);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('rejects a non-positive or non-finite window', async () => {
    const key = uniqueKey();
    await expect(consumeRateLimit(key, 1, 0, T)).rejects.toThrow(/window/i);
    await expect(consumeRateLimit(key, 1, -1000, T)).rejects.toThrow(/window/i);
    await expect(consumeRateLimit(key, 1, Number.NaN, T)).rejects.toThrow(/window/i);
    await expect(consumeRateLimit(key, 1, Number.POSITIVE_INFINITY, T)).rejects.toThrow(
      /window/i,
    );
  });

  it('rejects an empty key rather than bucketing every caller together', async () => {
    await expect(consumeRateLimit('', 1, MINUTE, T)).rejects.toThrow(/key/i);
    await expect(consumeRateLimit('   ', 1, MINUTE, T)).rejects.toThrow(/key/i);
    await expect(
      consumeRateLimit(undefined as unknown as string, 1, MINUTE, T),
    ).rejects.toThrow(/key/i);
  });

  it('rejects an invalid now', async () => {
    await expect(
      consumeRateLimit(uniqueKey(), 1, MINUTE, new Date('nonsense')),
    ).rejects.toThrow(/now/i);
  });

  it('uses a single atomic upsert, not read-then-write', async () => {
    const key = uniqueKey();
    const findOneAndUpdate = vi.spyOn(Collection.prototype, 'findOneAndUpdate');
    const findOne = vi.spyOn(Collection.prototype, 'findOne');
    const updateOne = vi.spyOn(Collection.prototype, 'updateOne');
    const insertOne = vi.spyOn(Collection.prototype, 'insertOne');

    await consumeRateLimit(key, 5, MINUTE, T);

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(findOne).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(insertOne).not.toHaveBeenCalled();

    const [filter, update, options] = findOneAndUpdate.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(filter).toEqual({ _id: `${key}:${windowIndexOf(T, MINUTE)}` });
    expect(update.$inc).toEqual({ count: 1 });
    expect(options.upsert).toBe(true);
    expect(options.returnDocument).toBe('after');
  });
});

describe('consumeRateLimit under concurrency', () => {
  it('never lets more than `limit` callers through', async () => {
    const key = uniqueKey('race');
    const limit = 10;
    const attempts = 100;

    const results = await Promise.all(
      Array.from({ length: attempts }, () => consumeRateLimit(key, limit, MINUTE, T)),
    );

    const allowed = results.filter((r) => r.allowed);
    expect(allowed).toHaveLength(limit);
    expect(results.every((r) => r.remaining >= 0)).toBe(true);
    // Every allowed caller saw a distinct remaining count: the counter is
    // incremented atomically, so no two callers can read the same value.
    expect(new Set(allowed.map((r) => r.remaining)).size).toBe(limit);

    const doc = await docFor(key, T, MINUTE);
    expect(doc?.count).toBe(attempts);
  });

  it('survives the upsert race that creates the window document', async () => {
    // Many first-ever calls for the same key race to insert the same _id.
    const key = uniqueKey('upsert-race');
    const results = await Promise.all(
      Array.from({ length: 40 }, () => consumeRateLimit(key, 40, MINUTE, T)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(40);
    const doc = await docFor(key, T, MINUTE);
    expect(doc?.count).toBe(40);
  });

  it('keeps concurrent keys isolated', async () => {
    const a = uniqueKey('iso-a');
    const b = uniqueKey('iso-b');
    const results = await Promise.all([
      ...Array.from({ length: 20 }, () => consumeRateLimit(a, 5, MINUTE, T)),
      ...Array.from({ length: 20 }, () => consumeRateLimit(b, 5, MINUTE, T)),
    ]);
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect((await docFor(a, T, MINUTE))?.count).toBe(20);
    expect((await docFor(b, T, MINUTE))?.count).toBe(20);
  });

  it('retries a duplicate-key error from a racing upsert', async () => {
    type Proto = { findOneAndUpdate: (...args: unknown[]) => Promise<unknown> };
    const proto = Collection.prototype as unknown as Proto;
    const original = proto.findOneAndUpdate;
    let calls = 0;
    proto.findOneAndUpdate = function patched(this: unknown, ...args: unknown[]) {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(
          Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }),
        );
      }
      return original.apply(this, args);
    };

    try {
      const key = uniqueKey('dup');
      const result = await consumeRateLimit(key, 2, MINUTE, T);
      expect(result.allowed).toBe(true);
      expect(calls).toBeGreaterThan(1);
    } finally {
      proto.findOneAndUpdate = original;
    }
  });

  it('assumes a single use if the driver returns no document', async () => {
    type Proto = { findOneAndUpdate: (...args: unknown[]) => Promise<unknown> };
    const proto = Collection.prototype as unknown as Proto;
    const original = proto.findOneAndUpdate;
    proto.findOneAndUpdate = () => Promise.resolve(null);
    try {
      const result = await consumeRateLimit(uniqueKey(), 3, MINUTE, T);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
    } finally {
      proto.findOneAndUpdate = original;
    }
  });

  it('propagates an unexpected database error instead of silently allowing', async () => {
    type Proto = { findOneAndUpdate: (...args: unknown[]) => Promise<unknown> };
    const proto = Collection.prototype as unknown as Proto;
    const original = proto.findOneAndUpdate;
    proto.findOneAndUpdate = () => Promise.reject(new Error('connection reset'));
    try {
      await expect(consumeRateLimit(uniqueKey(), 5, MINUTE, T)).rejects.toThrow(
        'connection reset',
      );
    } finally {
      proto.findOneAndUpdate = original;
    }
  });
});

describe('peekRateLimit', () => {
  it('reports the full allowance when nothing has been consumed', async () => {
    const key = uniqueKey();
    const result = await peekRateLimit(key, 5, T);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
  });

  it('does not consume', async () => {
    const key = uniqueKey();
    for (let i = 0; i < 10; i += 1) {
      await peekRateLimit(key, 2, T);
    }
    const col = await rateLimitsCollection();
    const docs = await col.find({}).toArray();
    expect(docs.filter((d) => d._id.startsWith(`${key}:`))).toHaveLength(0);
    // A real consume afterwards still has the whole allowance.
    expect((await consumeRateLimit(key, 2, MINUTE, T)).remaining).toBe(1);
  });

  it('does not change the count of an existing window', async () => {
    const key = uniqueKey();
    await consumeRateLimit(key, 5, MINUTE, T);
    await peekRateLimit(key, 5, T);
    await peekRateLimit(key, 5, T);
    expect((await docFor(key, T, MINUTE))?.count).toBe(1);
  });

  it('reflects what has been consumed in the active window', async () => {
    const key = uniqueKey();
    await consumeRateLimit(key, 5, MINUTE, T);
    await consumeRateLimit(key, 5, MINUTE, T);
    const peeked = await peekRateLimit(key, 5, T);
    expect(peeked).toEqual({
      allowed: true,
      remaining: 3,
      resetAt: new Date('2026-08-01T12:01:00.000Z'),
    });
  });

  it('reports denied once the limit is reached', async () => {
    const key = uniqueKey();
    await consumeRateLimit(key, 2, MINUTE, T);
    await consumeRateLimit(key, 2, MINUTE, T);
    const peeked = await peekRateLimit(key, 2, T);
    expect(peeked.allowed).toBe(false);
    expect(peeked.remaining).toBe(0);
  });

  it('reports denied when the window is over-consumed', async () => {
    const key = uniqueKey();
    for (let i = 0; i < 6; i += 1) await consumeRateLimit(key, 2, MINUTE, T);
    const peeked = await peekRateLimit(key, 2, T);
    expect(peeked.allowed).toBe(false);
    expect(peeked.remaining).toBe(0);
  });

  it('ignores a window that has already expired', async () => {
    const key = uniqueKey();
    const col = await rateLimitsCollection();
    const stale: RateLimitDoc = {
      _id: `${key}:${windowIndexOf(new Date(T.getTime() - HOUR), MINUTE)}`,
      count: 99,
      windowStart: new Date(T.getTime() - HOUR),
      expiresAt: new Date(T.getTime() - HOUR + MINUTE),
    };
    await col.insertOne(stale);

    const peeked = await peekRateLimit(key, 5, T);
    expect(peeked.allowed).toBe(true);
    expect(peeked.remaining).toBe(5);
  });

  it('reports the most recent active window when several overlap', async () => {
    const key = uniqueKey();
    await consumeRateLimit(key, 10, HOUR, T);
    await consumeRateLimit(key, 10, MINUTE, T);
    await consumeRateLimit(key, 10, MINUTE, T);
    const peeked = await peekRateLimit(key, 10, T);
    expect(peeked.remaining).toBe(8);
    expect(peeked.resetAt).toEqual(new Date('2026-08-01T12:01:00.000Z'));
  });

  it('does not leak between keys that share a prefix', async () => {
    const base = uniqueKey('prefix');
    await consumeRateLimit(`${base}:email:user@example.com`, 3, MINUTE, T);
    await consumeRateLimit(`${base}extra`, 3, MINUTE, T);
    const peeked = await peekRateLimit(base, 3, T);
    expect(peeked.remaining).toBe(3);
    expect(peeked.allowed).toBe(true);
  });

  it('treats regular-expression metacharacters in the key literally', async () => {
    const base = uniqueKey('meta');
    await consumeRateLimit(`${base}abc`, 3, MINUTE, T);
    const peeked = await peekRateLimit(`${base}a.c`, 3, T);
    expect(peeked.remaining).toBe(3);

    const dangerous = `${base}(a+)+$`;
    await consumeRateLimit(dangerous, 3, MINUTE, T);
    expect((await peekRateLimit(dangerous, 3, T)).remaining).toBe(2);
  });

  it('denies when the limit is zero even with no usage', async () => {
    const peeked = await peekRateLimit(uniqueKey(), 0, T);
    expect(peeked.allowed).toBe(false);
    expect(peeked.remaining).toBe(0);
  });

  it('fails closed for a non-numeric limit', async () => {
    const peeked = await peekRateLimit(uniqueKey(), Number.NaN, T);
    expect(peeked.allowed).toBe(false);
    expect(peeked.remaining).toBe(0);
  });

  it('rejects an empty key', async () => {
    await expect(peekRateLimit('', 1, T)).rejects.toThrow(/key/i);
  });

  it('defaults now to the current time', async () => {
    const key = uniqueKey();
    await consumeRateLimit(key, 4, HOUR);
    const peeked = await peekRateLimit(key, 4);
    expect(peeked.remaining).toBe(3);
  });

  it('never writes to the collection', async () => {
    const key = uniqueKey();
    const updateOne = vi.spyOn(Collection.prototype, 'updateOne');
    const insertOne = vi.spyOn(Collection.prototype, 'insertOne');
    const findOneAndUpdate = vi.spyOn(Collection.prototype, 'findOneAndUpdate');
    await peekRateLimit(key, 5, T);
    expect(updateOne).not.toHaveBeenCalled();
    expect(insertOne).not.toHaveBeenCalled();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('PII safety', () => {
  it('never writes an email address to the logs', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    const key = `signup:email:victim@example.com:${uniqueKey()}`;
    await consumeRateLimit(key, 1, MINUTE, T);
    await consumeRateLimit(key, 1, MINUTE, T);
    await peekRateLimit(key, 1, T);

    const written = spies.flatMap((s) => s.mock.calls).flat().join(' ');
    expect(written).not.toContain('victim@example.com');
  });
});
