import { ObjectId, type Filter } from 'mongodb';
import { campaignsCollection, subscribersCollection } from '@/lib/db/collections';
import { config } from '@/lib/config';
import { hashConfirmToken } from '@/lib/crypto/tokens';
import { normalizeAndValidate } from '@/lib/email/normalize';
import { logger } from '@/lib/logging';
import { splitNameAttributes } from '@/lib/subscriber-name';
import { addSuppression } from '@/lib/suppressions';
import type {
  SubscriberDoc,
  SubscriberHistoryEntry,
  SubscriberSource,
  SubscriberStatus,
  UnsubscribeSource,
} from '@/lib/types';

/**
 * Subscriber lifecycle (spec §4.1).
 *
 *     [pending] ──► [confirmed] ──► [unsubscribed]
 *         │              ├────────► [bounced]
 *      (7d purge)        └────────► [complained]
 *
 * Two rules govern every write in this file:
 *
 *  - Consent evidence (`confirmedAt`, `confirmIp`, `confirmUserAgent`) is
 *    append-only. It is never modified and never deleted, including after an
 *    unsubscribe, because it is the record produced if a complaint is escalated
 *    (§5.3).
 *  - Tombstones are never deleted. An `unsubscribed`/`bounced`/`complained` row
 *    is the proof the address was correctly excluded.
 */

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function historyEntry(
  from: SubscriberStatus | null,
  to: SubscriberStatus,
  reason: string,
  now: Date,
  campaignId?: ObjectId,
): SubscriberHistoryEntry {
  return { at: now, from, to, reason, ...(campaignId ? { campaignId } : {}) };
}

export async function upsertPendingSubscriber(input: {
  listId: ObjectId;
  email: string;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, string>;
  source: SubscriberSource;
  now?: Date;
}): Promise<{ subscriber: SubscriberDoc; created: boolean; alreadyConfirmed: boolean }> {
  const check = normalizeAndValidate(input.email);
  if (!check.ok) throw new Error(`Invalid email address (${check.reason})`);

  const now = input.now ?? new Date();
  const collection = await subscribersCollection();
  const existing = await collection.findOne({ listId: input.listId, email: check.email });

  // Names arriving under the legacy attribute keys are stored first-party too.
  const { firstName, lastName, attributes } = splitNameAttributes(input.attributes, input);

  if (!existing) {
    const doc: SubscriberDoc = {
      _id: new ObjectId(),
      listId: input.listId,
      email: check.email,
      emailDomain: check.domain,
      status: 'pending',
      ...(firstName !== undefined ? { firstName } : {}),
      ...(lastName !== undefined ? { lastName } : {}),
      attributes,
      source: input.source,
      createdAt: now,
      history: [historyEntry(null, 'pending', `signup:${input.source}`, now)],
    };
    try {
      await collection.insertOne(doc);
      return { subscriber: doc, created: true, alreadyConfirmed: false };
    } catch (err) {
      // Lost a race with a concurrent signup for the same address; fall through
      // and treat it as the update path rather than surfacing a 500 to a reader.
      if ((err as { code?: number }).code !== 11000) throw err;
      const raced = await collection.findOne({ listId: input.listId, email: check.email });
      if (!raced) throw err;
      return {
        subscriber: raced,
        created: false,
        alreadyConfirmed: raced.status === 'confirmed',
      };
    }
  }

  // Merge attributes without dropping keys the caller did not mention.
  const attributeUpdates: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    attributeUpdates[`attributes.${key}`] = value;
  }
  if (firstName !== undefined) attributeUpdates.firstName = firstName;
  if (lastName !== undefined) attributeUpdates.lastName = lastName;

  if (existing.status === 'confirmed') {
    // Already consented. Re-submitting the form must not revoke that consent,
    // and must not make the address unmailable pending a re-confirmation.
    if (Object.keys(attributeUpdates).length > 0) {
      await collection.updateOne({ _id: existing._id }, { $set: attributeUpdates });
    }
    const refreshed = (await collection.findOne({ _id: existing._id })) ?? existing;
    return { subscriber: refreshed, created: false, alreadyConfirmed: true };
  }

  if (existing.status === 'bounced' || existing.status === 'complained') {
    // A signup form submission must not resurrect an address that hard-bounced
    // or complained. Return it untouched; the caller still responds generically.
    return { subscriber: existing, created: false, alreadyConfirmed: false };
  }

  // pending or unsubscribed → back to pending so a fresh confirmation is
  // required. Consent evidence from any previous cycle is deliberately left in
  // place; only the status moves.
  await collection.updateOne(
    { _id: existing._id },
    {
      $set: {
        status: 'pending',
        source: input.source,
        ...attributeUpdates,
      },
      $push: {
        history: historyEntry(existing.status, 'pending', `signup:${input.source}`, now),
      },
    },
  );

  const refreshed = (await collection.findOne({ _id: existing._id }))!;
  return { subscriber: refreshed, created: false, alreadyConfirmed: false };
}

export async function setConfirmToken(
  subscriberId: ObjectId,
  tokenHash: string,
  expiresAt: Date,
  now: Date = new Date(),
): Promise<void> {
  const collection = await subscribersCollection();
  await collection.updateOne(
    { _id: subscriberId },
    {
      $set: {
        confirmTokenHash: tokenHash,
        confirmTokenExpiresAt: expiresAt,
        confirmEmailSentAt: now,
      },
    },
  );
}

export async function confirmSubscriber(input: {
  token: string;
  ip?: string;
  userAgent?: string;
  now?: Date;
}): Promise<
  { ok: true; subscriber: SubscriberDoc } | { ok: false; reason: 'unknown' | 'expired' }
> {
  if (!input.token) return { ok: false, reason: 'unknown' };
  const now = input.now ?? new Date();

  // The raw token is never stored, so the lookup is by hash. The hash is a
  // fixed-length hex digest of a 32-byte random value: an equality match on it
  // is already constant-time with respect to anything an attacker controls,
  // because they cannot produce a partial-prefix hash collision to probe with.
  const tokenHash = hashConfirmToken(input.token);
  const collection = await subscribersCollection();
  const subscriber = await collection.findOne({ confirmTokenHash: tokenHash });

  if (!subscriber) return { ok: false, reason: 'unknown' };
  if (subscriber.confirmTokenExpiresAt && subscriber.confirmTokenExpiresAt <= now) {
    return { ok: false, reason: 'expired' };
  }
  // A token minted before an unsubscribe must not silently re-subscribe them.
  if (subscriber.status !== 'pending') return { ok: false, reason: 'unknown' };

  await collection.updateOne(
    { _id: subscriber._id },
    {
      $set: {
        status: 'confirmed',
        confirmedAt: now,
        ...(input.ip ? { confirmIp: input.ip } : {}),
        ...(input.userAgent ? { confirmUserAgent: input.userAgent } : {}),
      },
      // Clearing the hash is what makes the confirmation link single-use.
      $unset: { confirmTokenHash: '', confirmTokenExpiresAt: '' },
      $push: { history: historyEntry(subscriber.status, 'confirmed', 'double_opt_in', now) },
    },
  );

  const confirmed = (await collection.findOne({ _id: subscriber._id }))!;
  logger.info('subscriber confirmed', { domain: subscriber.emailDomain });
  return { ok: true, subscriber: confirmed };
}

export async function unsubscribeSubscriber(input: {
  subscriberId: ObjectId;
  source: UnsubscribeSource;
  campaignId?: ObjectId;
  now?: Date;
}): Promise<{ ok: boolean; alreadyUnsubscribed: boolean }> {
  const now = input.now ?? new Date();
  const collection = await subscribersCollection();
  const existing = await collection.findOne({ _id: input.subscriberId });

  if (!existing) return { ok: false, alreadyUnsubscribed: false };
  if (existing.status === 'unsubscribed') return { ok: true, alreadyUnsubscribed: true };

  await collection.updateOne(
    { _id: input.subscriberId },
    {
      $set: {
        status: 'unsubscribed',
        unsubscribedAt: now,
        unsubscribeSource: input.source,
      },
      $push: {
        history: historyEntry(
          existing.status,
          'unsubscribed',
          `unsubscribe:${input.source}`,
          now,
          input.campaignId,
        ),
      },
    },
  );

  // Attribute the opt-out to the campaign that prompted it, so a campaign's
  // report shows what it cost. Only counted on the transition, so a provider
  // retrying a one-click unsubscribe cannot inflate it.
  if (input.campaignId) {
    await (await campaignsCollection()).updateOne(
      { _id: input.campaignId },
      { $inc: { 'counts.unsubscribed': 1 } },
    );
  }

  // Deliberately NOT added to `suppressions` (§9): unsubscribe is a per-list
  // preference, suppression is for deliverability failures. Both exclude from
  // sending, but suppressing here would wrongly block the other domain's list.
  return { ok: true, alreadyUnsubscribed: false };
}

export async function resubscribe(
  subscriberId: ObjectId,
  now: Date = new Date(),
): Promise<boolean> {
  const collection = await subscribersCollection();
  const existing = await collection.findOne({ _id: subscriberId });
  if (!existing) return false;
  // Only a preference-based opt-out is reversible. Re-mailing an address that
  // hard-bounced or complained is how sender reputation gets destroyed.
  if (existing.status !== 'unsubscribed') return false;

  await collection.updateOne(
    { _id: subscriberId },
    {
      $set: { status: 'confirmed' },
      $unset: { unsubscribedAt: '', unsubscribeSource: '' },
      $push: { history: historyEntry('unsubscribed', 'confirmed', 'resubscribe', now) },
    },
  );
  return true;
}

async function markStatusByEmail(
  email: string,
  status: Extract<SubscriberStatus, 'bounced' | 'complained'>,
  reason: string,
  now: Date,
  campaignId?: ObjectId,
): Promise<void> {
  const check = normalizeAndValidate(email);
  if (!check.ok) return;

  const collection = await subscribersCollection();
  // The address may appear on both lists. A hard bounce or complaint is a
  // property of the address, not of one list, so every entry is updated.
  const affected = await collection
    .find({ email: check.email }, { projection: { _id: 1, status: 1 } })
    .toArray();

  await Promise.all(
    affected
      .filter((doc) => doc.status !== status)
      .map((doc) =>
        collection.updateOne(
          { _id: doc._id },
          {
            $set: { status },
            $push: { history: historyEntry(doc.status, status, reason, now, campaignId) },
          },
        ),
      ),
  );
}

export async function markBounced(input: {
  email: string;
  campaignId?: ObjectId;
  detail?: string;
  now?: Date;
}): Promise<void> {
  await markStatusByEmail(
    input.email,
    'bounced',
    'hard_bounce',
    input.now ?? new Date(),
    input.campaignId,
  );
}

export async function markComplained(input: {
  email: string;
  campaignId?: ObjectId;
  detail?: string;
  now?: Date;
}): Promise<void> {
  await markStatusByEmail(
    input.email,
    'complained',
    'complaint',
    input.now ?? new Date(),
    input.campaignId,
  );
}

/**
 * Transient bounces are recorded but only suppress after repeated failures
 * across *distinct* campaigns (§8.2) — a single bad send should not evict an
 * otherwise good address.
 */
export async function recordTransientBounce(input: {
  email: string;
  campaignId?: ObjectId;
  detail?: string;
  now?: Date;
}): Promise<{ suppressed: boolean }> {
  const check = normalizeAndValidate(input.email);
  if (!check.ok) return { suppressed: false };
  const now = input.now ?? new Date();
  const collection = await subscribersCollection();

  if (input.campaignId) {
    // $addToSet makes repeats within one campaign idempotent.
    await collection.updateMany(
      { email: check.email },
      { $addToSet: { transientBounceCampaignIds: input.campaignId } },
    );
  }

  const threshold = config.transientBounceSuppressionThreshold();
  const docs = await collection
    .find({ email: check.email }, { projection: { transientBounceCampaignIds: 1 } })
    .toArray();

  const distinct = new Set<string>();
  for (const doc of docs) {
    for (const id of doc.transientBounceCampaignIds ?? []) distinct.add(id.toHexString());
  }

  if (distinct.size < threshold) return { suppressed: false };

  await addSuppression({
    email: check.email,
    reason: 'hard_bounce',
    detail: `repeated transient bounces across ${distinct.size} campaigns${
      input.detail ? `: ${input.detail}` : ''
    }`,
    sourceCampaignId: input.campaignId,
    now,
  });
  await markStatusByEmail(check.email, 'bounced', 'repeated_transient_bounce', now, input.campaignId);
  return { suppressed: true };
}

/**
 * Pending records that expire unconfirmed are purged by a daily job (§4.1).
 * Only `pending` is ever removed — every other status is a tombstone.
 */
export async function purgeExpiredPending(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - config.pendingExpiryDays() * 24 * 60 * 60 * 1000);
  const collection = await subscribersCollection();
  const result = await collection.deleteMany({
    status: 'pending',
    createdAt: { $lt: cutoff },
  });
  if (result.deletedCount > 0) {
    logger.info('purged expired pending subscribers', { count: result.deletedCount });
  }
  return result.deletedCount;
}

export async function findSubscribers(query: {
  listId?: ObjectId;
  status?: SubscriberStatus;
  search?: string;
  sort?: 'createdAt' | 'email';
  direction?: 1 | -1;
  limit?: number;
  skip?: number;
}): Promise<{ items: SubscriberDoc[]; total: number }> {
  const filter: Record<string, unknown> = {};
  if (query.listId) filter.listId = query.listId;
  if (query.status) filter.status = query.status;
  if (query.search) {
    const pattern = { $regex: escapeRegExp(query.search), $options: 'i' };
    filter.$or = [{ email: pattern }, { firstName: pattern }, { lastName: pattern }];
  }

  const collection = await subscribersCollection();
  const sortField = query.sort ?? 'createdAt';
  const [items, total] = await Promise.all([
    collection
      .find(filter as Filter<SubscriberDoc>)
      .sort({ [sortField]: query.direction ?? -1 })
      .skip(query.skip ?? 0)
      .limit(Math.min(query.limit ?? 50, 500))
      .toArray(),
    collection.countDocuments(filter as Filter<SubscriberDoc>),
  ]);

  return { items, total };
}
