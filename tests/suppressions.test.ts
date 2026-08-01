import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  addSuppression,
  filterSuppressed,
  isSuppressed,
  listSuppressions,
  removeSuppression,
} from '@/lib/suppressions';
import { suppressionsCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';

beforeEach(async () => {
  await ensureIndexes();
  await (await suppressionsCollection()).deleteMany({});
});

describe('addSuppression', () => {
  it('records the address with its reason and origin', async () => {
    const campaignId = new ObjectId();
    const result = await addSuppression({
      email: 'Bounced@Example.COM',
      reason: 'hard_bounce',
      detail: 'smtp; 550 5.1.1 user unknown',
      sourceCampaignId: campaignId,
    });

    expect(result.created).toBe(true);
    const doc = await (await suppressionsCollection()).findOne({});
    // Normalized on the way in, so a differently-cased retry still matches.
    expect(doc?.email).toBe('bounced@example.com');
    expect(doc?.reason).toBe('hard_bounce');
    expect(doc?.detail).toBe('smtp; 550 5.1.1 user unknown');
    expect(doc?.sourceCampaignId?.toHexString()).toBe(campaignId.toHexString());
  });

  it('is idempotent: a duplicate returns created=false instead of throwing', async () => {
    await addSuppression({ email: 'dupe@example.com', reason: 'complaint' });
    const second = await addSuppression({ email: 'dupe@example.com', reason: 'complaint' });

    expect(second.created).toBe(false);
    expect(await (await suppressionsCollection()).countDocuments()).toBe(1);
  });

  it('never overwrites the original reason on a repeat suppression', async () => {
    await addSuppression({ email: 'first@example.com', reason: 'complaint', detail: 'original' });
    await addSuppression({ email: 'first@example.com', reason: 'import', detail: 'later' });

    const doc = await (await suppressionsCollection()).findOne({ email: 'first@example.com' });
    // The first reason is the evidentiary one; a later import must not rewrite history.
    expect(doc?.reason).toBe('complaint');
    expect(doc?.detail).toBe('original');
  });

  it('survives concurrent inserts of the same address', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        addSuppression({ email: 'race@example.com', reason: 'hard_bounce' }),
      ),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await (await suppressionsCollection()).countDocuments()).toBe(1);
  });

  it('rejects an unparseable address rather than storing junk', async () => {
    await expect(addSuppression({ email: 'not-an-email', reason: 'manual' })).rejects.toThrow();
    expect(await (await suppressionsCollection()).countDocuments()).toBe(0);
  });
});

describe('isSuppressed', () => {
  it('matches regardless of case and surrounding whitespace', async () => {
    await addSuppression({ email: 'person@example.com', reason: 'complaint' });

    expect(await isSuppressed('person@example.com')).toBe(true);
    expect(await isSuppressed('  PERSON@Example.com  ')).toBe(true);
    expect(await isSuppressed('other@example.com')).toBe(false);
  });

  it('returns false for an empty or malformed address without throwing', async () => {
    expect(await isSuppressed('')).toBe(false);
    expect(await isSuppressed('garbage')).toBe(false);
  });
});

describe('filterSuppressed', () => {
  it('returns only the suppressed subset', async () => {
    await addSuppression({ email: 'a@example.com', reason: 'hard_bounce' });
    await addSuppression({ email: 'c@example.com', reason: 'complaint' });

    const suppressed = await filterSuppressed([
      'a@example.com',
      'b@example.com',
      'C@EXAMPLE.COM',
    ]);

    expect(suppressed).toEqual(new Set(['a@example.com', 'c@example.com']));
  });

  it('handles an empty input without querying', async () => {
    expect(await filterSuppressed([])).toEqual(new Set());
  });

  it('handles batches larger than a single query comfortably', async () => {
    const emails = Array.from({ length: 500 }, (_, i) => `bulk-${i}@example.com`);
    for (let i = 0; i < 500; i += 25) {
      await addSuppression({ email: emails[i], reason: 'hard_bounce' });
    }

    const suppressed = await filterSuppressed(emails);
    expect(suppressed.size).toBe(20);
  });
});

describe('removeSuppression', () => {
  it('removes an address and reports whether anything was removed', async () => {
    await addSuppression({ email: 'oops@example.com', reason: 'manual' });

    expect(await removeSuppression('OOPS@example.com')).toBe(true);
    expect(await isSuppressed('oops@example.com')).toBe(false);
    expect(await removeSuppression('oops@example.com')).toBe(false);
  });
});

describe('listSuppressions', () => {
  it('paginates newest first and reports the total', async () => {
    for (let i = 0; i < 5; i += 1) {
      await addSuppression({
        email: `list-${i}@example.com`,
        reason: 'hard_bounce',
        now: new Date(Date.UTC(2026, 0, i + 1)),
      });
    }

    const page = await listSuppressions({ limit: 2, skip: 0 });
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
    expect(page.items[0].email).toBe('list-4@example.com');
  });

  it('filters by a search term', async () => {
    await addSuppression({ email: 'match@searchable.com', reason: 'complaint' });
    await addSuppression({ email: 'nomatch@example.com', reason: 'complaint' });

    const found = await listSuppressions({ search: 'searchable' });
    expect(found.total).toBe(1);
    expect(found.items[0].email).toBe('match@searchable.com');
  });

  it('treats a search term as a literal, not a regular expression', async () => {
    await addSuppression({ email: 'literal@example.com', reason: 'manual' });

    // A user typing ".*" must not match everything.
    const found = await listSuppressions({ search: '.*' });
    expect(found.total).toBe(0);
  });
});
