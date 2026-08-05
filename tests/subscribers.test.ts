import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  confirmSubscriber,
  findSubscribers,
  markBounced,
  markComplained,
  purgeExpiredPending,
  recordTransientBounce,
  resubscribe,
  setConfirmToken,
  unsubscribeSubscriber,
  upsertPendingSubscriber,
} from '@/lib/subscribers';
import { generateConfirmToken, hashConfirmToken } from '@/lib/crypto/tokens';
import { isSuppressed } from '@/lib/suppressions';
import { subscribersCollection, suppressionsCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { createList, createSubscriber } from '@tests/helpers/factories';
import type { ListDoc } from '@/lib/types';

let list: ListDoc;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await subscribersCollection()).deleteMany({}),
    (await suppressionsCollection()).deleteMany({}),
  ]);
  list = await createList();
});

describe('upsertPendingSubscriber', () => {
  it('creates a pending subscriber with a normalized address', async () => {
    const { subscriber, created, alreadyConfirmed } = await upsertPendingSubscriber({
      listId: list._id,
      email: '  Reader@Example.COM ',
      source: 'web_form',
    });

    expect(created).toBe(true);
    expect(alreadyConfirmed).toBe(false);
    expect(subscriber.email).toBe('reader@example.com');
    expect(subscriber.emailDomain).toBe('example.com');
    expect(subscriber.status).toBe('pending');
  });

  it('is idempotent for a repeat signup and does not duplicate', async () => {
    await upsertPendingSubscriber({ listId: list._id, email: 'a@example.com', source: 'web_form' });
    const second = await upsertPendingSubscriber({
      listId: list._id,
      email: 'a@example.com',
      source: 'web_form',
    });

    expect(second.created).toBe(false);
    expect(await (await subscribersCollection()).countDocuments()).toBe(1);
  });

  it('never demotes a confirmed subscriber back to pending', async () => {
    // Re-submitting the form must not silently revoke an existing consent
    // record, and must not make the address unmailable until they re-confirm.
    const existing = await createSubscriber(list._id, {
      email: 'confirmed@example.com',
      status: 'confirmed',
    });

    const result = await upsertPendingSubscriber({
      listId: list._id,
      email: 'confirmed@example.com',
      source: 'web_form',
    });

    expect(result.alreadyConfirmed).toBe(true);
    const doc = await (await subscribersCollection()).findOne({ _id: existing._id });
    expect(doc?.status).toBe('confirmed');
    expect(doc?.confirmedAt).toEqual(existing.confirmedAt);
  });

  it('preserves consent evidence when an unsubscribed address signs up again', async () => {
    const original = await createSubscriber(list._id, {
      email: 'returning@example.com',
      status: 'unsubscribed',
      confirmedAt: new Date('2025-01-01T00:00:00.000Z'),
      confirmIp: '198.51.100.4',
      confirmUserAgent: 'OriginalAgent/1.0',
      unsubscribedAt: new Date('2025-06-01T00:00:00.000Z'),
    });

    await upsertPendingSubscriber({
      listId: list._id,
      email: 'returning@example.com',
      source: 'web_form',
    });

    const doc = await (await subscribersCollection()).findOne({ _id: original._id });
    expect(doc?.status).toBe('pending');
    // §5.3: consent evidence is append-only, never modified after being written.
    expect(doc?.confirmIp).toBe('198.51.100.4');
    expect(doc?.confirmUserAgent).toBe('OriginalAgent/1.0');
    expect(doc?.confirmedAt).toEqual(new Date('2025-01-01T00:00:00.000Z'));
  });

  it('merges attributes without dropping existing ones', async () => {
    await upsertPendingSubscriber({
      listId: list._id,
      email: 'attrs@example.com',
      source: 'web_form',
      attributes: { firstName: 'Ada', city: 'London' },
    });
    await upsertPendingSubscriber({
      listId: list._id,
      email: 'attrs@example.com',
      source: 'web_form',
      attributes: { city: 'Paris' },
    });

    const doc = await (await subscribersCollection()).findOne({ email: 'attrs@example.com' });
    expect(doc?.attributes).toEqual({ firstName: 'Ada', city: 'Paris' });
  });

  it('stores first and last name first-party', async () => {
    await upsertPendingSubscriber({
      listId: list._id,
      email: 'named@example.com',
      firstName: '  Ada ',
      lastName: 'Lovelace',
      source: 'web_form',
    });

    const doc = await (await subscribersCollection()).findOne({ email: 'named@example.com' });
    expect(doc?.firstName).toBe('Ada');
    expect(doc?.lastName).toBe('Lovelace');
  });

  it('routes first_name/last_name attribute keys to the first-party fields', async () => {
    await upsertPendingSubscriber({
      listId: list._id,
      email: 'routed@example.com',
      source: 'web_form',
      attributes: { first_name: 'Ada', last_name: 'Lovelace', city: 'London' },
    });

    const doc = await (await subscribersCollection()).findOne({ email: 'routed@example.com' });
    expect(doc?.firstName).toBe('Ada');
    expect(doc?.lastName).toBe('Lovelace');
    expect(doc?.attributes).toEqual({ city: 'London' });
  });

  it('updates the name on a repeat signup without touching what it was not given', async () => {
    await upsertPendingSubscriber({
      listId: list._id,
      email: 'renamed@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      source: 'web_form',
    });
    await upsertPendingSubscriber({
      listId: list._id,
      email: 'renamed@example.com',
      firstName: 'Augusta',
      source: 'web_form',
    });

    const doc = await (await subscribersCollection()).findOne({ email: 'renamed@example.com' });
    expect(doc?.firstName).toBe('Augusta');
    expect(doc?.lastName).toBe('Lovelace');
  });

  it('rejects an invalid address', async () => {
    await expect(
      upsertPendingSubscriber({ listId: list._id, email: 'nope', source: 'web_form' }),
    ).rejects.toThrow();
  });

  it('keeps the same address on two different lists separate', async () => {
    const other = await createList({ name: 'Domain B' });
    await upsertPendingSubscriber({ listId: list._id, email: 'both@example.com', source: 'web_form' });
    await upsertPendingSubscriber({ listId: other._id, email: 'both@example.com', source: 'web_form' });

    expect(await (await subscribersCollection()).countDocuments()).toBe(2);
  });
});

describe('confirmSubscriber', () => {
  async function seedPending(email = 'pending@example.com') {
    const { subscriber } = await upsertPendingSubscriber({
      listId: list._id,
      email,
      source: 'web_form',
    });
    const { token, tokenHash, expiresAt } = generateConfirmToken();
    await setConfirmToken(subscriber._id, tokenHash, expiresAt);
    return { subscriber, token };
  }

  it('confirms and records the consent evidence', async () => {
    const { subscriber, token } = await seedPending();

    const result = await confirmSubscriber({
      token,
      ip: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (confirm)',
    });

    expect(result.ok).toBe(true);
    const doc = await (await subscribersCollection()).findOne({ _id: subscriber._id });
    expect(doc?.status).toBe('confirmed');
    expect(doc?.confirmedAt).toBeInstanceOf(Date);
    expect(doc?.confirmIp).toBe('203.0.113.9');
    expect(doc?.confirmUserAgent).toBe('Mozilla/5.0 (confirm)');
  });

  it('clears the token hash so the link cannot be replayed', async () => {
    const { subscriber, token } = await seedPending();
    await confirmSubscriber({ token });

    const doc = await (await subscribersCollection()).findOne({ _id: subscriber._id });
    expect(doc?.confirmTokenHash).toBeUndefined();

    const replay = await confirmSubscriber({ token });
    expect(replay).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects an expired token', async () => {
    const { subscriber } = await upsertPendingSubscriber({
      listId: list._id,
      email: 'expired@example.com',
      source: 'web_form',
    });
    const { token, tokenHash } = generateConfirmToken();
    await setConfirmToken(subscriber._id, tokenHash, new Date(Date.now() - 1000));

    const result = await confirmSubscriber({ token });
    expect(result).toEqual({ ok: false, reason: 'expired' });

    const doc = await (await subscribersCollection()).findOne({ _id: subscriber._id });
    expect(doc?.status).toBe('pending');
  });

  it('rejects an unknown or malformed token without throwing', async () => {
    expect(await confirmSubscriber({ token: 'totally-made-up' })).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(await confirmSubscriber({ token: '' })).toEqual({ ok: false, reason: 'unknown' });
  });

  it('stores only the hash of the token, never the token itself', async () => {
    const { subscriber, token } = await seedPending('hashonly@example.com');
    const beforeConfirm = await (await subscribersCollection()).findOne({ _id: subscriber._id });

    expect(beforeConfirm?.confirmTokenHash).toBe(hashConfirmToken(token));
    expect(JSON.stringify(beforeConfirm)).not.toContain(token);
  });

  it('does not resurrect an unsubscribed address via a stale confirm link', async () => {
    const { subscriber, token } = await seedPending('stale@example.com');
    await confirmSubscriber({ token });
    await unsubscribeSubscriber({ subscriberId: subscriber._id, source: 'one_click' });

    const replay = await confirmSubscriber({ token });
    expect(replay.ok).toBe(false);
    const doc = await (await subscribersCollection()).findOne({ _id: subscriber._id });
    expect(doc?.status).toBe('unsubscribed');
  });
});

describe('unsubscribeSubscriber', () => {
  it('sets the status, timestamp and source', async () => {
    const sub = await createSubscriber(list._id, { email: 'bye@example.com' });

    const result = await unsubscribeSubscriber({
      subscriberId: sub._id,
      source: 'one_click',
    });

    expect(result).toEqual({ ok: true, alreadyUnsubscribed: false });
    const doc = await (await subscribersCollection()).findOne({ _id: sub._id });
    expect(doc?.status).toBe('unsubscribed');
    expect(doc?.unsubscribeSource).toBe('one_click');
    expect(doc?.unsubscribedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — a repeated one-click unsubscribe still reports success', async () => {
    const sub = await createSubscriber(list._id, { email: 'twice@example.com' });
    await unsubscribeSubscriber({ subscriberId: sub._id, source: 'one_click' });
    const second = await unsubscribeSubscriber({ subscriberId: sub._id, source: 'one_click' });

    expect(second).toEqual({ ok: true, alreadyUnsubscribed: true });
  });

  it('does NOT add the address to the global suppression list', async () => {
    // §9: unsubscribe is a per-list preference; suppression is for
    // deliverability failures. Both exclude from sending, but conflating them
    // would wrongly block the other domain's list too.
    const sub = await createSubscriber(list._id, { email: 'pref@example.com' });
    await unsubscribeSubscriber({ subscriberId: sub._id, source: 'one_click' });

    expect(await isSuppressed('pref@example.com')).toBe(false);
  });

  it('preserves consent evidence as a tombstone', async () => {
    const sub = await createSubscriber(list._id, {
      email: 'tomb@example.com',
      confirmIp: '192.0.2.50',
      confirmUserAgent: 'Agent/9',
    });
    await unsubscribeSubscriber({ subscriberId: sub._id, source: 'admin' });

    const doc = await (await subscribersCollection()).findOne({ _id: sub._id });
    expect(doc).not.toBeNull();
    expect(doc?.confirmIp).toBe('192.0.2.50');
    expect(doc?.confirmUserAgent).toBe('Agent/9');
  });

  it('reports failure for an unknown subscriber', async () => {
    const result = await unsubscribeSubscriber({
      subscriberId: new ObjectId(),
      source: 'one_click',
    });
    expect(result.ok).toBe(false);
  });

  it('attributes the opt-out to the campaign that prompted it', async () => {
    const { campaignsCollection } = await import('@/lib/db/collections');
    const { createCampaign } = await import('@tests/helpers/factories');
    const campaign = await createCampaign(list._id);
    const sub = await createSubscriber(list._id, { email: 'cost@example.com' });

    await unsubscribeSubscriber({
      subscriberId: sub._id,
      source: 'one_click',
      campaignId: campaign._id,
    });

    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.counts.unsubscribed).toBe(1);
  });

  it('does not let a retried one-click unsubscribe inflate the campaign count', async () => {
    const { campaignsCollection } = await import('@/lib/db/collections');
    const { createCampaign } = await import('@tests/helpers/factories');
    const campaign = await createCampaign(list._id);
    const sub = await createSubscriber(list._id, { email: 'retry@example.com' });

    for (let i = 0; i < 3; i += 1) {
      await unsubscribeSubscriber({
        subscriberId: sub._id,
        source: 'one_click',
        campaignId: campaign._id,
      });
    }

    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.counts.unsubscribed).toBe(1);
  });
});

describe('resubscribe', () => {
  it('returns an unsubscribed address to confirmed', async () => {
    const sub = await createSubscriber(list._id, {
      email: 'back@example.com',
      status: 'unsubscribed',
      confirmedAt: new Date('2025-03-03T00:00:00.000Z'),
    });

    expect(await resubscribe(sub._id)).toBe(true);
    const doc = await (await subscribersCollection()).findOne({ _id: sub._id });
    expect(doc?.status).toBe('confirmed');
    expect(doc?.confirmedAt).toEqual(new Date('2025-03-03T00:00:00.000Z'));
  });

  it('refuses to resubscribe a bounced or complained address', async () => {
    // Re-mailing an address that hard-bounced or complained is exactly how
    // sender reputation is destroyed.
    const bounced = await createSubscriber(list._id, {
      email: 'hard@example.com',
      status: 'bounced',
    });
    const complained = await createSubscriber(list._id, {
      email: 'spam@example.com',
      status: 'complained',
    });

    expect(await resubscribe(bounced._id)).toBe(false);
    expect(await resubscribe(complained._id)).toBe(false);
  });
});

describe('bounce and complaint handling', () => {
  it('marks every list entry for the address as bounced', async () => {
    const other = await createList({ name: 'Domain B' });
    await createSubscriber(list._id, { email: 'shared@example.com' });
    await createSubscriber(other._id, { email: 'shared@example.com' });

    await markBounced({ email: 'shared@example.com', detail: '550 unknown' });

    const docs = await (await subscribersCollection())
      .find({ email: 'shared@example.com' })
      .toArray();
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.status === 'bounced')).toBe(true);
  });

  it('marks complaints and records them in history', async () => {
    const sub = await createSubscriber(list._id, { email: 'complainer@example.com' });
    await markComplained({ email: 'complainer@example.com' });

    const doc = await (await subscribersCollection()).findOne({ _id: sub._id });
    expect(doc?.status).toBe('complained');
    expect(doc?.history.at(-1)?.to).toBe('complained');
  });

  it('is a no-op for an address that is not a subscriber', async () => {
    await expect(markBounced({ email: 'ghost@example.com' })).resolves.not.toThrow();
  });

  it('suppresses only after transient bounces across distinct campaigns', async () => {
    await createSubscriber(list._id, { email: 'transient@example.com' });
    const campaignA = new ObjectId();
    const campaignB = new ObjectId();
    const campaignC = new ObjectId();

    // Repeats within one campaign must not accumulate — a single bad send
    // should not evict a good address.
    expect((await recordTransientBounce({ email: 'transient@example.com', campaignId: campaignA })).suppressed).toBe(false);
    expect((await recordTransientBounce({ email: 'transient@example.com', campaignId: campaignA })).suppressed).toBe(false);
    expect((await recordTransientBounce({ email: 'transient@example.com', campaignId: campaignB })).suppressed).toBe(false);

    const third = await recordTransientBounce({
      email: 'transient@example.com',
      campaignId: campaignC,
    });
    expect(third.suppressed).toBe(true);
    expect(await isSuppressed('transient@example.com')).toBe(true);
  });
});

describe('purgeExpiredPending', () => {
  it('purges pending records older than the expiry window and nothing else', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const old = new Date('2026-07-20T00:00:00.000Z');   // 12 days — expired
    const recent = new Date('2026-07-29T00:00:00.000Z'); // 3 days — still valid

    await createSubscriber(list._id, { email: 'oldpending@example.com', status: 'pending', createdAt: old });
    await createSubscriber(list._id, { email: 'newpending@example.com', status: 'pending', createdAt: recent });
    await createSubscriber(list._id, { email: 'oldconfirmed@example.com', status: 'confirmed', createdAt: old });
    await createSubscriber(list._id, { email: 'oldunsub@example.com', status: 'unsubscribed', createdAt: old });

    const purged = await purgeExpiredPending(now);
    expect(purged).toBe(1);

    const remaining = await (await subscribersCollection()).find({}).toArray();
    expect(remaining.map((d) => d.email).sort()).toEqual([
      'newpending@example.com',
      'oldconfirmed@example.com',
      'oldunsub@example.com',
    ]);
  });

  it('never deletes tombstones', async () => {
    // §4.1: unsubscribed, bounced and complained records are retained forever.
    // They are the proof the address was correctly excluded.
    const ancient = new Date('2020-01-01T00:00:00.000Z');
    for (const status of ['unsubscribed', 'bounced', 'complained'] as const) {
      await createSubscriber(list._id, { email: `${status}@example.com`, status, createdAt: ancient });
    }

    await purgeExpiredPending(new Date('2026-08-01T00:00:00.000Z'));
    expect(await (await subscribersCollection()).countDocuments()).toBe(3);
  });
});

describe('findSubscribers', () => {
  beforeEach(async () => {
    await createSubscriber(list._id, {
      email: 'alpha@searchme.com',
      status: 'confirmed',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createSubscriber(list._id, {
      email: 'beta@example.com',
      status: 'pending',
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await createSubscriber(list._id, {
      email: 'gamma@example.com',
      status: 'confirmed',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
  });

  it('filters by status', async () => {
    const result = await findSubscribers({ listId: list._id, status: 'confirmed' });
    expect(result.total).toBe(2);
  });

  it('searches by email substring, treating the term literally', async () => {
    expect((await findSubscribers({ listId: list._id, search: 'searchme' })).total).toBe(1);
    expect((await findSubscribers({ listId: list._id, search: '.*' })).total).toBe(0);
  });

  it('searches by first and last name', async () => {
    await createSubscriber(list._id, {
      email: 'named@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    expect((await findSubscribers({ listId: list._id, search: 'ada' })).total).toBe(1);
    expect((await findSubscribers({ listId: list._id, search: 'lovelace' })).total).toBe(1);
    expect((await findSubscribers({ listId: list._id, search: 'byron' })).total).toBe(0);
  });

  it('sorts by signup date in both directions', async () => {
    const asc = await findSubscribers({ listId: list._id, sort: 'createdAt', direction: 1 });
    expect(asc.items[0].email).toBe('alpha@searchme.com');

    const desc = await findSubscribers({ listId: list._id, sort: 'createdAt', direction: -1 });
    expect(desc.items[0].email).toBe('gamma@example.com');
  });

  it('paginates while reporting the unpaginated total', async () => {
    const page = await findSubscribers({ listId: list._id, limit: 2, skip: 0 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
  });
});
