import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { countSegment, resolveSegmentRecipients, segmentToFilter } from '@/lib/segments';
import {
  eventsCollection,
  sentLogCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { createList, createSubscriber, createSuppression } from '@tests/helpers/factories';
import type { ListDoc } from '@/lib/types';

let list: ListDoc;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await subscribersCollection()).deleteMany({}),
    (await suppressionsCollection()).deleteMany({}),
    (await sentLogCollection()).deleteMany({}),
    (await eventsCollection()).deleteMany({}),
  ]);
  list = await createList();
});

describe('segmentToFilter', () => {
  it('always constrains to the list and to confirmed status', () => {
    const filter = segmentToFilter(list._id, {}) as Record<string, unknown>;
    expect(filter.listId).toEqual(list._id);
    expect(filter.status).toBe('confirmed');
  });

  it('refuses to let a query override the implicit confirmed status', () => {
    // Spec §4.2: status is *always* implicitly confirmed. Only confirmed
    // subscribers are ever sent a campaign (§4.1), so this must not be
    // expressible as a segment option.
    const filter = segmentToFilter(list._id, {
      status: 'unsubscribed',
    } as never) as Record<string, unknown>;
    expect(filter.status).toBe('confirmed');
  });

  it('builds a signup date range that is lower-inclusive and upper-exclusive', () => {
    const filter = segmentToFilter(list._id, {
      signedUpAfter: '2026-01-01T00:00:00.000Z',
      signedUpBefore: '2026-02-01T00:00:00.000Z',
    }) as Record<string, Record<string, Date>>;

    expect(filter.createdAt.$gte).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(filter.createdAt.$lt).toEqual(new Date('2026-02-01T00:00:00.000Z'));
  });

  it('ignores an unparseable date rather than silently matching everyone', () => {
    expect(() => segmentToFilter(list._id, { signedUpAfter: 'not-a-date' })).toThrow();
  });

  it('maps attribute equality and existence onto the attributes subdocument', () => {
    const filter = segmentToFilter(list._id, {
      attributeEquals: [{ key: 'city', value: 'London' }],
      attributeExists: ['firstName'],
    }) as Record<string, unknown>;

    expect(filter['attributes.city']).toBe('London');
    expect(filter['attributes.firstName']).toEqual({ $exists: true, $nin: [null, ''] });
  });

  it('rejects attribute keys that could reach outside the attributes subdocument', () => {
    // A key containing a dot or a $ is a query-injection vector.
    expect(() =>
      segmentToFilter(list._id, { attributeEquals: [{ key: 'a.b', value: 'x' }] }),
    ).toThrow();
    expect(() =>
      segmentToFilter(list._id, { attributeEquals: [{ key: '$where', value: 'x' }] }),
    ).toThrow();
    expect(() => segmentToFilter(list._id, { attributeExists: ['x.y'] })).toThrow();
  });

  it('filters by signup source', () => {
    const filter = segmentToFilter(list._id, { source: 'import' }) as Record<string, unknown>;
    expect(filter.source).toBe('import');
  });
});

describe('countSegment', () => {
  it('counts only confirmed subscribers on the given list', async () => {
    await createSubscriber(list._id, { email: 'a@example.com', status: 'confirmed' });
    await createSubscriber(list._id, { email: 'b@example.com', status: 'confirmed' });
    await createSubscriber(list._id, { email: 'c@example.com', status: 'pending' });
    await createSubscriber(list._id, { email: 'd@example.com', status: 'unsubscribed' });
    await createSubscriber(list._id, { email: 'e@example.com', status: 'bounced' });

    const otherList = await createList({ name: 'Other' });
    await createSubscriber(otherList._id, { email: 'f@example.com', status: 'confirmed' });

    expect(await countSegment(list._id, {})).toBe(2);
  });

  it('narrows by attribute equality', async () => {
    await createSubscriber(list._id, {
      email: 'london@example.com',
      attributes: { city: 'London' },
    });
    await createSubscriber(list._id, {
      email: 'paris@example.com',
      attributes: { city: 'Paris' },
    });

    expect(
      await countSegment(list._id, { attributeEquals: [{ key: 'city', value: 'London' }] }),
    ).toBe(1);
  });

  it('matches first_name against both first-party and legacy storage', async () => {
    await createSubscriber(list._id, { email: 'first-party@example.com', firstName: 'Ada' });
    await createSubscriber(list._id, {
      email: 'legacy@example.com',
      attributes: { first_name: 'Ada' },
    });
    // The first-party field overrides a stale legacy attribute, so this
    // subscriber renders "Grace" and must not match a segment on "Ada".
    await createSubscriber(list._id, {
      email: 'overridden@example.com',
      firstName: 'Grace',
      attributes: { first_name: 'Ada' },
    });

    expect(
      await countSegment(list._id, { attributeEquals: [{ key: 'first_name', value: 'Ada' }] }),
    ).toBe(2);
    expect(await countSegment(list._id, { attributeExists: ['first_name'] })).toBe(3);
    expect(
      await countSegment(list._id, {
        attributeEquals: [
          { key: 'first_name', value: 'Ada' },
          { key: 'last_name', value: 'Lovelace' },
        ],
      }),
    ).toBe(0);
  });

  it('narrows by engagement across the last N campaigns of the list', async () => {
    const engaged = await createSubscriber(list._id, { email: 'engaged@example.com' });
    await createSubscriber(list._id, { email: 'quiet@example.com' });

    const recentCampaign = new ObjectId();
    await (await eventsCollection()).insertOne({
      _id: new ObjectId(),
      campaignId: recentCampaign,
      subscriberId: engaged._id,
      type: 'open',
      ts: new Date(),
    });

    // Only campaigns that actually exist for this list count, so seed one.
    const { campaignsCollection } = await import('@/lib/db/collections');
    await (await campaignsCollection()).insertOne({
      _id: recentCampaign,
      listId: list._id,
      subject: 's',
      preheader: '',
      bodySource: { type: 'doc', content: [] },
      status: 'sent',
      segmentQuery: {},
      trackOpens: true,
      trackClicks: false,
      counts: {
        recipients: 0, sent: 0, failed: 0, bounced: 0,
        complained: 0, unsubscribed: 0, delivered: 0, opened: 0, clicked: 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    });

    expect(await countSegment(list._id, { openedInLastNCampaigns: 3 })).toBe(1);
  });
});

describe('resolveSegmentRecipients', () => {
  it('excludes suppressed addresses even though they are confirmed subscribers', async () => {
    const keep = await createSubscriber(list._id, { email: 'keep@example.com' });
    await createSubscriber(list._id, { email: 'suppressed@example.com' });
    await createSuppression({ email: 'suppressed@example.com', reason: 'hard_bounce' });

    const ids = await resolveSegmentRecipients({
      listId: list._id,
      query: {},
      campaignId: new ObjectId(),
    });

    expect(ids.map(String)).toEqual([keep._id.toHexString()]);
  });

  it('excludes anyone already in sent_log for this campaign', async () => {
    const campaignId = new ObjectId();
    const fresh = await createSubscriber(list._id, { email: 'fresh@example.com' });
    const already = await createSubscriber(list._id, { email: 'already@example.com' });

    await (await sentLogCollection()).insertOne({
      _id: new ObjectId(),
      campaignId,
      subscriberId: already._id,
      sentAt: new Date(),
    });

    const ids = await resolveSegmentRecipients({ listId: list._id, query: {}, campaignId });
    expect(ids.map(String)).toEqual([fresh._id.toHexString()]);
  });

  it('does not exclude someone sent a different campaign', async () => {
    const sub = await createSubscriber(list._id, { email: 'other@example.com' });
    await (await sentLogCollection()).insertOne({
      _id: new ObjectId(),
      campaignId: new ObjectId(),
      subscriberId: sub._id,
      sentAt: new Date(),
    });

    const ids = await resolveSegmentRecipients({
      listId: list._id,
      query: {},
      campaignId: new ObjectId(),
    });
    expect(ids).toHaveLength(1);
  });

  it('excludes every non-confirmed status', async () => {
    await createSubscriber(list._id, { email: 'p@example.com', status: 'pending' });
    await createSubscriber(list._id, { email: 'u@example.com', status: 'unsubscribed' });
    await createSubscriber(list._id, { email: 'b@example.com', status: 'bounced' });
    await createSubscriber(list._id, { email: 'c@example.com', status: 'complained' });

    const ids = await resolveSegmentRecipients({
      listId: list._id,
      query: {},
      campaignId: new ObjectId(),
    });
    expect(ids).toEqual([]);
  });

  it('scales past a single batch of suppression lookups', async () => {
    for (let i = 0; i < 120; i += 1) {
      await createSubscriber(list._id, { email: `scale-${i}@example.com` });
    }
    await createSuppression({ email: 'scale-7@example.com', reason: 'complaint' });

    const ids = await resolveSegmentRecipients({
      listId: list._id,
      query: {},
      campaignId: new ObjectId(),
    });
    expect(ids).toHaveLength(119);
  });
});
