import { ObjectId } from 'mongodb';
import { CONFIRM_TOKEN_TTL_DAYS, env } from './env';
import { collections, isDuplicateKeyError } from './db';
import { hmacHex, randomToken, safeEqual } from './crypto';
import { emailDomain, normalizeEmail } from './email-address';
import type { SubscriberDoc, SubscriberSource } from './types';

/**
 * Subscriber lifecycle (§4.1).
 *
 *     pending ──► confirmed ──► unsubscribed
 *        │            ├──────► bounced
 *     (7d purge)      └──────► complained
 *
 * Only `confirmed` subscribers are ever sent a campaign. Tombstones are never
 * deleted: they are the proof the address was correctly excluded.
 */

export function hashConfirmToken(token: string): string {
  return hmacHex(env.confirmTokenSecret, token);
}

export interface UpsertPendingResult {
  subscriber: SubscriberDoc;
  /** A raw token, only when a confirmation email should now be sent. */
  token: string | null;
  /** True when the record already existed in `confirmed` state. */
  alreadyConfirmed: boolean;
  /** True when a resend was suppressed by the once-per-hour rule (§5.1). */
  rateLimited: boolean;
}

/**
 * Creates or refreshes a pending subscriber and mints a confirmation token.
 *
 * Never resets consent state: an already-confirmed address stays confirmed and
 * gets no new token, because re-confirming someone who already opted in is
 * both pointless and a way to lose them.
 */
export async function upsertPendingSubscriber(input: {
  listId: ObjectId;
  email: string;
  attributes?: Record<string, string>;
  source: SubscriberSource;
}): Promise<UpsertPendingResult> {
  const c = await collections();
  const email = normalizeEmail(input.email);
  const now = new Date();

  const existing = await c.subscribers.findOne({ listId: input.listId, email });

  if (existing && existing.status === 'confirmed') {
    if (input.attributes && Object.keys(input.attributes).length > 0) {
      await c.subscribers.updateOne(
        { _id: existing._id },
        { $set: { ...prefixAttributes(input.attributes), updatedAt: now } },
      );
    }
    return { subscriber: existing, token: null, alreadyConfirmed: true, rateLimited: false };
  }

  // Re-subscribing after an unsubscribe is allowed, but only through the full
  // double opt-in flow — the record returns to `pending`, not to `confirmed`.
  const resendCutoff = new Date(now.getTime() - env.confirmResendIntervalSec * 1000);
  if (existing?.confirmEmailSentAt && existing.confirmEmailSentAt > resendCutoff) {
    return { subscriber: existing, token: null, alreadyConfirmed: false, rateLimited: true };
  }

  const token = randomToken(32);
  const tokenHash = hashConfirmToken(token);
  const expiresAt = new Date(now.getTime() + CONFIRM_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  // MongoDB rejects an update whose `$set` and `$setOnInsert` touch the same
  // path — `attributes.first_name` in one and `attributes` in the other is a
  // conflict, not a merge. Setting the sub-paths alone also creates the parent
  // document on insert, so `attributes` is only seeded when there are none.
  const attributePaths = prefixAttributes(input.attributes ?? {});
  const hasAttributes = Object.keys(attributePaths).length > 0;

  const updated = await c.subscribers.findOneAndUpdate(
    { listId: input.listId, email },
    {
      $set: {
        status: 'pending',
        confirmTokenHash: tokenHash,
        confirmTokenExpiresAt: expiresAt,
        confirmEmailSentAt: now,
        updatedAt: now,
        ...attributePaths,
      },
      $setOnInsert: {
        listId: input.listId,
        email,
        emailDomain: emailDomain(email),
        ...(hasAttributes ? {} : { attributes: {} }),
        source: input.source,
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  if (!updated) throw new Error('Failed to upsert subscriber');
  return { subscriber: updated, token, alreadyConfirmed: false, rateLimited: false };
}

/** `$set` paths for attribute merging, so an update never clobbers other keys. */
function prefixAttributes(attributes: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[`attributes.${key}`] = value;
  }
  return out;
}

export type ConfirmResult =
  | { ok: true; subscriber: SubscriberDoc; alreadyConfirmed: boolean }
  | { ok: false; reason: 'unknown' | 'expired' };

/**
 * Consumes a confirmation token (§5.2).
 *
 * The lookup is by hash — the raw token is never stored — and the stored hash
 * is compared in constant time even though the index lookup already matched,
 * because the index lookup is the part an attacker can time.
 */
export async function confirmSubscriber(input: {
  token: string;
  ip: string;
  userAgent: string;
}): Promise<ConfirmResult> {
  const c = await collections();
  const tokenHash = hashConfirmToken(input.token);
  const now = new Date();

  const subscriber = await c.subscribers.findOne({ confirmTokenHash: tokenHash });
  if (!subscriber || !subscriber.confirmTokenHash || !safeEqual(subscriber.confirmTokenHash, tokenHash)) {
    return { ok: false, reason: 'unknown' };
  }
  if (subscriber.confirmTokenExpiresAt && subscriber.confirmTokenExpiresAt < now) {
    return { ok: false, reason: 'expired' };
  }
  if (subscriber.status === 'confirmed') {
    return { ok: true, subscriber, alreadyConfirmed: true };
  }

  // Consent evidence is append-only (§5.3): a subscriber who unsubscribed and
  // came back keeps the original evidence, and the token is cleared either way.
  const setEvidence =
    subscriber.confirmedAt == null
      ? { confirmedAt: now, confirmIp: input.ip, confirmUserAgent: input.userAgent }
      : {};

  const updated = await c.subscribers.findOneAndUpdate(
    { _id: subscriber._id, confirmTokenHash: tokenHash },
    {
      $set: {
        status: 'confirmed',
        ...setEvidence,
        confirmTokenHash: null,
        confirmTokenExpiresAt: null,
        unsubscribedAt: null,
        unsubscribeSource: null,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );

  if (!updated) return { ok: false, reason: 'unknown' };
  return { ok: true, subscriber: updated, alreadyConfirmed: false };
}

/**
 * Import upsert (§4.3). Idempotent on `{listId, email}`: re-importing updates
 * attributes and never duplicates or resets consent state.
 */
export async function upsertImportedSubscriber(input: {
  listId: ObjectId;
  email: string;
  attributes: Record<string, string>;
  confirmed: boolean;
  attestationId?: ObjectId | null;
}): Promise<'created' | 'updated'> {
  const c = await collections();
  const email = normalizeEmail(input.email);
  const now = new Date();

  const existing = await c.subscribers.findOne({ listId: input.listId, email });
  if (existing) {
    await c.subscribers.updateOne(
      { _id: existing._id },
      { $set: { ...prefixAttributes(input.attributes), updatedAt: now } },
    );
    return 'updated';
  }

  const doc: Omit<SubscriberDoc, '_id'> = {
    listId: input.listId,
    email,
    emailDomain: emailDomain(email),
    status: input.confirmed ? 'confirmed' : 'pending',
    attributes: input.attributes,
    source: 'import',
    createdAt: now,
    updatedAt: now,
    confirmedAt: input.confirmed ? now : null,
    confirmIp: null,
    confirmUserAgent: null,
    confirmAttestationId: input.confirmed ? (input.attestationId ?? null) : null,
  };

  try {
    await c.subscribers.insertOne(doc as SubscriberDoc);
    return 'created';
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Lost a race with a concurrent chunk; treat as an update.
      await c.subscribers.updateOne(
        { listId: input.listId, email },
        { $set: { ...prefixAttributes(input.attributes), updatedAt: now } },
      );
      return 'updated';
    }
    throw error;
  }
}

/** Mints a fresh confirmation token for a pending subscriber (queued imports). */
export async function issueConfirmToken(subscriberId: ObjectId): Promise<string | null> {
  const c = await collections();
  const now = new Date();
  const token = randomToken(32);
  const result = await c.subscribers.updateOne(
    { _id: subscriberId, status: 'pending' },
    {
      $set: {
        confirmTokenHash: hashConfirmToken(token),
        confirmTokenExpiresAt: new Date(now.getTime() + CONFIRM_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
        confirmEmailSentAt: now,
        updatedAt: now,
      },
    },
  );
  return result.matchedCount === 1 ? token : null;
}
